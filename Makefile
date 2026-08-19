.PHONY: install test once run docker-up docker-down

install:
	pip install -r requirements.txt
	pip install -e .

test:
	pytest -q

once:
	python -m mexc_assistant.main --once --dry-run

run:
	python -m mexc_assistant.main

docker-up:
	docker compose up -d --build

docker-down:
	docker compose down
