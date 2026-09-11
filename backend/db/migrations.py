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
    (6, "Validate bundled vector index", "Load vector extension and safely rebuild incompatible dimensions"),
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
                if version in (2, 6):
                    await apply_migration_v2(session)
                else:
                    # These tables are defined in the authoritative ORM schema.
                    Base.metadata.create_all(bind=session.connection())
                
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
    from backend.db.vector_schema import ensure_vector_schema, load_vector_extension
    connection = session.connection().connection.driver_connection
    load_vector_extension(connection)
    ensure_vector_schema(connection, 384)
