.PHONY: install run serve

install:
	uv sync

run:
	uv run main.py

serve:
	uv run python serve.py
