# Digital Twin Watch — Agent Rules

## Development environment

- Development is done with Muse Code and Meta models.
- The application's own AI integrations must use Meta exclusively. Do not add AI providers from other vendors.

## Secrets and API keys

- API keys and other secrets are used only in the backend, loaded from environment variables.
- Never include secrets in source code, Git history, the frontend, or logs.
- Never print, log, or expose secret values. Refer to them by variable name only.
- A `.env.example` file may list variable names with empty or placeholder values, but must never contain real secrets.

## Repository visibility

- This repository stays private until the submission is prepared.
- Do not change the repository visibility.

## Language

- The product interface and product documentation are in English.
- Communicate with the project owner in Romanian.

## Honesty about functionality

- Do not present planned features or simulated results as functional or real.
- Clearly label anything that is planned, mocked, or simulated as such, in code, UI, and documentation.
