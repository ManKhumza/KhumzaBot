from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional, List, AsyncGenerator
import uuid
import json
import asyncio
import httpx
import logging
from datetime import datetime

from backend.auth.dependencies import get_db, get_current_user, require_permission
from backend.db.models import Collection, Conversation, Document, Message, Model, User
from backend.inference.lifecycle import ModelLifecycleManager

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)

class ConversationResponse(BaseModel):
    id: str
    userId: str
    title: str
    modelId: Optional[str]
    collectionId: Optional[str]
    systemPrompt: Optional[str]
    temperature: float
    maxTokens: int
    isArchived: bool
    createdAt: str
    updatedAt: str

class MessageResponse(BaseModel):
    id: str
    conversationId: str
    role: str
    content: str
    modelId: Optional[str]
    tokenCount: Optional[int]
    generationTimeMs: Optional[int]
    citations: List[dict]
    metadata: dict
    createdAt: str

class CreateConversationRequest(BaseModel):
    title: Optional[str] = None
    modelId: Optional[str] = None
    collectionId: Optional[str] = None
    systemPrompt: Optional[str] = None
    temperature: float = Field(0.7, ge=0, le=2)
    maxTokens: int = Field(4096, ge=1, le=32768)

class ChatRequest(BaseModel):
    conversationId: str
    message: str = Field(..., min_length=1, max_length=100000)
    modelId: Optional[str] = None
    collectionId: Optional[str] = None
    stream: bool = True
    temperature: Optional[float] = Field(None, ge=0, le=2)
    maxTokens: Optional[int] = Field(None, ge=1, le=32768)

class UpdateConversationRequest(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    modelId: Optional[str] = None
    collectionId: Optional[str] = None
    systemPrompt: Optional[str] = Field(None, max_length=20000)
    temperature: Optional[float] = Field(None, ge=0, le=2)
    maxTokens: Optional[int] = Field(None, ge=1, le=32768)

class ChatChunk(BaseModel):
    id: str
    delta: str
    finishReason: Optional[str]
    citations: Optional[List[dict]] = None
    usage: Optional[dict] = None

def get_model_manager(request: Request) -> ModelLifecycleManager:
    return request.app.state.model_manager

def get_settings(request: Request):
    return request.app.state.settings

async def call_llama_server(
    client: httpx.AsyncClient,
    messages: List[dict],
    temperature: float,
    max_tokens: int,
    stream: bool,
) -> AsyncGenerator[dict, None]:
    """Call llama-server for chat completion."""
    payload = {
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
    }
    
    if not stream:
        response = await client.post("/v1/chat/completions", json=payload)
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        yield response.json()
        return

    async with client.stream("POST", "/v1/chat/completions", json=payload) as response:
        if response.status_code != 200:
            error_text = await response.aread()
            raise HTTPException(status_code=response.status_code, detail=error_text.decode())

        async for line in response.aiter_lines():
            if line.startswith("data: "):
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                try:
                    yield json.loads(data)
                except json.JSONDecodeError:
                    continue

@router.get("/conversations", response_model=List[ConversationResponse])
async def list_conversations(
    current_user: User = Depends(require_permission("chat:read_own")),
    db: Session = Depends(get_db)
):
    conversations = db.query(Conversation).filter(
        Conversation.user_id == current_user.id
    ).order_by(Conversation.updated_at.desc()).all()
    return [conversation_to_response(c) for c in conversations]

@router.post("/conversations", response_model=ConversationResponse)
async def create_conversation(
    request: CreateConversationRequest,
    current_user: User = Depends(require_permission("chat:create")),
    db: Session = Depends(get_db)
):
    conversation = Conversation(
        id=str(uuid.uuid4()),
        user_id=current_user.id,
        title=request.title or "New Chat",
        model_id=request.modelId,
        collection_id=request.collectionId,
        system_prompt=request.systemPrompt,
        temperature=round(request.temperature * 100),
        max_tokens=request.maxTokens,
    )
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation_to_response(conversation)

@router.get("/conversations/{conversation_id}", response_model=ConversationResponse)
async def get_conversation(
    conversation_id: str,
    current_user: User = Depends(require_permission("chat:read_own")),
    db: Session = Depends(get_db)
):
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.user_id == current_user.id
    ).first()
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    return conversation_to_response(conversation)

@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    current_user: User = Depends(require_permission("chat:delete_own")),
    db: Session = Depends(get_db)
):
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.user_id == current_user.id
    ).first()
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    db.delete(conversation)
    db.commit()
    return {"success": True}

@router.patch("/conversations/{conversation_id}", response_model=ConversationResponse)
async def update_conversation(
    conversation_id: str,
    request: UpdateConversationRequest,
    current_user: User = Depends(require_permission("chat:read_own")),
    db: Session = Depends(get_db)
):
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.user_id == current_user.id
    ).first()
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    
    if request.title is not None:
        conversation.title = request.title

    if "modelId" in request.model_fields_set:
        if request.modelId is not None:
            model = db.query(Model).filter(
                Model.id == request.modelId,
                Model.role == "chat",
                Model.status == "active",
            ).first()
            if model is None:
                raise HTTPException(400, "Selected chat model is not active")
        conversation.model_id = request.modelId

    if "collectionId" in request.model_fields_set:
        if request.collectionId is not None:
            collection = db.query(Collection).filter(
                Collection.id == request.collectionId,
                Collection.owner_id == current_user.id,
                Collection.status == "active",
            ).first()
            if collection is None:
                raise HTTPException(404, "Knowledge collection not found")
        conversation.collection_id = request.collectionId

    if "systemPrompt" in request.model_fields_set:
        conversation.system_prompt = request.systemPrompt
    if request.temperature is not None:
        conversation.temperature = round(request.temperature * 100)
    if request.maxTokens is not None:
        conversation.max_tokens = request.maxTokens
    
    db.commit()
    db.refresh(conversation)
    return conversation_to_response(conversation)

@router.get("/conversations/{conversation_id}/messages", response_model=List[MessageResponse])
async def get_messages(
    conversation_id: str,
    limit: int = 50,
    offset: int = 0,
    current_user: User = Depends(require_permission("chat:read_own")),
    db: Session = Depends(get_db)
):
    conversation = db.query(Conversation).filter(
        Conversation.id == conversation_id,
        Conversation.user_id == current_user.id
    ).first()
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    
    messages = db.query(Message).filter(
        Message.conversation_id == conversation_id
    ).order_by(Message.created_at).offset(offset).limit(limit).all()
    
    return [message_to_response(m) for m in messages]

@router.post("/completions")
async def chat_completion(
    request: ChatRequest,
    http_request: Request,
    current_user: User = Depends(require_permission("chat:create")),
    db: Session = Depends(get_db),
    model_manager: ModelLifecycleManager = Depends(get_model_manager),
    settings = Depends(get_settings),
):
    # Verify conversation ownership
    conversation = db.query(Conversation).filter(
        Conversation.id == request.conversationId,
        Conversation.user_id == current_user.id
    ).first()
    if not conversation:
        raise HTTPException(404, "Conversation not found")
    
    # Get model
    model_id = request.modelId or conversation.model_id
    if not model_id:
        raise HTTPException(400, "No model selected")
    
    model = db.query(Model).filter(Model.id == model_id).first()
    if not model:
        raise HTTPException(404, "Model not found")
    
    if model.status != "active":
        raise HTTPException(400, "Model is not active")
    
    # Ensure model is loaded
    chat_provider = model_manager.get_chat_provider()
    if not chat_provider or model_manager.active_chat_model_id != model.id:
        await model_manager.load_model(model, "chat")
        chat_provider = model_manager.get_chat_provider()
    
    if not chat_provider:
        raise HTTPException(500, "Failed to load model")
    
    # Save user message
    user_message = Message(
        id=str(uuid.uuid4()),
        conversation_id=request.conversationId,
        role="user",
        content=request.message,
        created_at=datetime.utcnow(),
    )
    db.add(user_message)
    db.commit()
    
    # Get conversation history
    messages = db.query(Message).filter(
        Message.conversation_id == request.conversationId
    ).order_by(Message.created_at).all()
    
    # Build messages for llama.cpp
    history = [{"role": m.role, "content": m.content} for m in messages]
    temperature = request.temperature if request.temperature is not None else conversation.temperature / 100.0
    max_tokens = request.maxTokens if request.maxTokens is not None else conversation.max_tokens
    
    citations: list[dict] = []
    collection_id = request.collectionId or conversation.collection_id
    if collection_id:
        collection = db.query(Collection).filter(
            Collection.id == collection_id,
            Collection.owner_id == current_user.id,
        ).first()
        if collection is None:
            raise HTTPException(404, "Knowledge collection not found")
        embedding_model = db.get(Model, collection.embedding_model_id)
        if embedding_model is None:
            raise HTTPException(409, "The collection embedding model is unavailable")
        embedding_provider = model_manager.get_embedding_provider()
        if embedding_provider is None or model_manager.active_embedding_model_id != embedding_model.id:
            embedding_provider = await model_manager.load_model(embedding_model, "embedding")
        query_embedding = await embedding_provider.embed_single(request.message)
        matches = await http_request.app.state.ingestion.vector_store.search(
            query_embedding, collection_ids=[collection.id], top_k=5
        )
        if matches:
            context = "\n\n".join(f"[Source {i + 1}] {hit.content}" for i, hit in enumerate(matches))
            history.insert(0, {
                "role": "system",
                "content": "Use these local sources when relevant and cite them as [Source N].\n\n" + context,
            })
            document_ids = {hit.document_id for hit in matches}
            documents = {
                item.id: item for item in db.query(Document).filter(Document.id.in_(document_ids)).all()
            }
            citations = [{
                "chunkId": hit.chunk_id,
                "documentId": hit.document_id,
                "documentName": documents[hit.document_id].original_filename if hit.document_id in documents else "Unknown",
                "collectionName": collection.name,
                "pageStart": hit.page_start,
                "pageEnd": hit.page_end,
                "sectionTitle": hit.section_title,
                "score": hit.score,
                "preview": hit.content[:240],
            } for hit in matches]
    
    generation_id = f"gen-{uuid.uuid4().hex[:12]}"
    
    async def generate_stream():
        full_content = ""
        usage = None
        try:
            base_url = f"http://127.0.0.1:{model_manager.get_chat_provider().port}"
            
            async for chunk_data in call_llama_server(
                client=chat_provider.client,
                messages=history,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            ):
                choice = chunk_data.get("choices", [{}])[0]
                delta = choice.get("delta", {}).get("content", "")
                finish_reason = choice.get("finish_reason")
                full_content += delta
                usage = chunk_data.get("usage") or usage
                
                chunk = ChatChunk(
                    id=generation_id,
                    delta=delta,
                    finishReason=finish_reason,
                    citations=citations,
                    usage=chunk_data.get("usage"),
                )
                
                yield f"data: {chunk.model_dump_json()}\n\n"
                
                if finish_reason:
                    break
        except Exception as e:
            logger.error(f"Generation error: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            if full_content:
                assistant_message = Message(
                    id=str(uuid.uuid4()),
                    conversation_id=request.conversationId,
                    role="assistant",
                    content=full_content,
                    citations=citations,
                    model_id=model.id,
                    token_count=usage.get("total_tokens") if usage else None,
                    created_at=datetime.utcnow(),
                )
                db.add(assistant_message)
                db.commit()
            yield "data: [DONE]\n\n"
    
    if request.stream:
        return StreamingResponse(
            generate_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Generation-ID": generation_id,
            }
        )
    else:
        # Non-streaming: collect all chunks
        full_content = ""
        usage = None
        
        async for chunk_data in call_llama_server(
            client=chat_provider.client,
            messages=history,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=False,
        ):
            choice = chunk_data.get("choices", [{}])[0]
            delta = choice.get("message", {}).get("content", "")
            full_content += delta
            if choice.get("finish_reason"):
                break
            usage = chunk_data.get("usage")
        
        # Save assistant message
        assistant_message = Message(
            id=str(uuid.uuid4()),
            conversation_id=request.conversationId,
            role="assistant",
            content=full_content,
            citations=citations,
            model_id=model.id,
            token_count=usage.get("total_tokens") if usage else None,
            created_at=datetime.utcnow(),
        )
        db.add(assistant_message)
        db.commit()
        
        return {
            "id": assistant_message.id,
            "conversationId": request.conversationId,
            "role": "assistant",
            "content": full_content,
            "citations": citations,
            "modelId": model.id,
            "usage": usage,
        }

@router.post("/stop/{generation_id}")
async def stop_generation(
    generation_id: str,
    current_user: User = Depends(get_current_user),
    model_manager: ModelLifecycleManager = Depends(get_model_manager),
):
    # TODO: Implement generation cancellation
    return {"stopped": True}

def conversation_to_response(c: Conversation) -> ConversationResponse:
    return ConversationResponse(
        id=c.id,
        userId=c.user_id,
        title=c.title,
        modelId=c.model_id,
        collectionId=c.collection_id,
        systemPrompt=c.system_prompt,
        temperature=c.temperature / 100.0,
        maxTokens=c.max_tokens,
        isArchived=c.is_archived,
        createdAt=c.created_at.isoformat() if c.created_at else "",
        updatedAt=c.updated_at.isoformat() if c.updated_at else "",
    )

def message_to_response(m: Message) -> MessageResponse:
    return MessageResponse(
        id=m.id,
        conversationId=m.conversation_id,
        role=m.role,
        content=m.content,
        modelId=m.model_id,
        tokenCount=m.token_count,
        generationTimeMs=m.generation_time_ms,
        citations=m.citations or [],
        metadata=m.message_metadata or {},
        createdAt=m.created_at.isoformat() if m.created_at else "",
    )
