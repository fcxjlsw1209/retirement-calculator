"""All database access in tests is isolated from the user's portfolio."""
import pytest
from sqlmodel import SQLModel, create_engine
from backend import db


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(db, "_engine", engine)
    yield
    engine.dispose()
