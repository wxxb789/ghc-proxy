# TODO

Tracked items for future work. Items are roughly ordered by priority.

## Research

- [ ] **Evaluate `ai-tokenizer` as a replacement for `gpt-tokenizer`**
  - Project: https://github.com/coder/ai-tokenizer
  - Current tokenizer: `gpt-tokenizer` (v3.4.0) — used in `src/lib/tokenizer.ts` for local token estimation in `count_tokens` endpoint and chat completions usage
  - Current usage: lazy-loaded encoders (`o200k_base`, `cl100k_base`, `p50k_base`, `p50k_edit`, `r50k_base`) cached per encoding type, with model-specific constants for tool/message token calculation
  - Questions to answer:
    - Does `ai-tokenizer` support the same encoding types?
    - How does bundle size compare? (`gpt-tokenizer` contributes to the single-file `dist/main.mjs`)
    - Performance: encoding speed, memory footprint
    - Does it support Bun natively?
    - Does it handle Claude/Anthropic tokenization or is it OpenAI-only like `gpt-tokenizer`?
    - Accuracy: does it produce the same token counts for the same inputs?
