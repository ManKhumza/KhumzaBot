from passlib.hash import argon2
import hmac

argon2_hasher = argon2.using(
    memory_cost=65536,
    time_cost=3,
    parallelism=4,
    hash_len=32,
    salt_size=16,
)

def hash_password(password: str) -> str:
    return argon2_hasher.hash(password)

def verify_password(password: str, hash: str) -> bool:
    return argon2_hasher.verify(password, hash)

def verify_session_token(token: str, expected: str) -> bool:
    return hmac.compare_digest(token, expected)