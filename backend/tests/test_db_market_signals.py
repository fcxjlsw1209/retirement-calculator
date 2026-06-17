from datetime import date, datetime

from sqlmodel import Session, SQLModel, create_engine

import backend.db as db
from backend.db import MarketSignals


def _use_temp_engine(tmp_path):
    old_engine = db._engine
    db._engine = create_engine(f"sqlite:///{tmp_path / 'retirement-calculator-test.db'}", echo=False)
    SQLModel.metadata.create_all(db._engine)
    return old_engine


def _insert_signal(record_date: date):
    with Session(db.engine()) as session:
        session.add(MarketSignals(
            record_date=record_date,
            vix=10.0,
            vxn=20.0,
            fg=50,
            rsi_sp500=60.0,
            fetched_at=datetime(2026, 5, 23, 9, 0),
        ))
        session.commit()


def test_get_market_signals_for_delta_uses_closest_roughly_week_old_row(tmp_path):
    old_engine = _use_temp_engine(tmp_path)
    try:
        _insert_signal(date(2026, 5, 13))
        _insert_signal(date(2026, 5, 16))
        _insert_signal(date(2026, 5, 18))

        prior = db.get_market_signals_for_delta(date(2026, 5, 23))

        assert prior is not None
        assert prior.record_date == date(2026, 5, 16)
    finally:
        db._engine = old_engine


def test_get_market_signals_for_delta_ignores_rows_outside_window(tmp_path):
    old_engine = _use_temp_engine(tmp_path)
    try:
        _insert_signal(date(2024, 1, 2))

        prior = db.get_market_signals_for_delta(date(2026, 5, 23))

        assert prior is None
    finally:
        db._engine = old_engine
