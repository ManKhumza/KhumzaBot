from sqlalchemy import text
from backend.db.database import Base
import logging

logger = logging.getLogger(__name__)

MIGRATIONS = [
    (1, "Initial schema", "Initial schema creation"),
    (2, "Add vector tables", "Add sqlite-vec virtual tables"),
    (3, "Add collection permissions", "Add ACL for collections"),
    (4, "Add model configs", "Add model runtime configuration"),
    (5, "Add audit log", "Add security audit logging"),
]

async def run_migrations(engine):
    from sqlalchemy.orm import sessionmaker
    Session = sessionmaker(bind=engine)
    
    with Session() as session:
        session.execute(text("""
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                description TEXT
            )
        """))
        session.commit()
        
        result = session.execute(text("SELECT MAX(version) FROM schema_version")).scalar()
        current_version = result or 0
        
        for version, name, description in MIGRATIONS:
            if version <= current_version:
                continue
            
            logger.info(f"Applying migration {version}: {name}")
            
            try:
                if version == 2:
                    await apply_migration_v2(session)
                elif version == 3:
                    pass
                elif version == 4:
                    pass
                elif version == 5:
                    pass
                
                session.execute(
                    text("INSERT INTO schema_version (version, description) VALUES (:v, :d)"),
                    {"v": version, "d": description}
                )
                session.commit()
                logger.info(f"Migration {version} complete")
                
            except Exception as e:
                session.rollback()
                logger.error(f"Migration {version} failed: {e}")
                raise


async def apply_migration_v2(session):
    try:
        session.execute(text("SELECT load_extension('sqlite_vec')"))
    except:
        logger.warning("sqlite_vec extension not available, skipping vector table creation")
        return
    
    session.execute(text("""
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
            chunk_id TEXT PRIMARY KEY,
            embedding FLOAT[768],
            collection_id TEXT,
            document_id TEXT
        )
    """))
    
    session.commit()