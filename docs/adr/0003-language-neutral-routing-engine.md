# ADR-0003: Language-Neutral Multidimensional Complexity & Structured Routing Engine

## Status
Accepted - 2026-09-29

## Context
Early prototype routing components relied heavily on keyword dictionaries across specific languages (such as "hello", "hi", "proof", "architecture", "prove").
Rule-based keyword dictionaries suffer from severe operational limitations:
1. **Multilingual Fragility**: When users submit queries in French, Japanese, Russian, Spanish, or code-mixed dialects, static lexicons immediately break down.
2. **Poor Generalization**: Synonyms, idioms, and colloquialisms are virtually infinite, making static vocabulary maintenance intractable.
3. **Invasive Hardcoding**: Embedding natural language vocabulary within core routing logic violates internationalization (i18n) and architectural isolation standards.

## Decision
1. **Complete Removal of Natural Language Dictionaries**:
   - Stripped all hardcoded language keyword lists from routing modules.
2. **Transition to Universal Mathematical, Structural, and Statistical Features**:
   - **Formal Mathematical Notation**: Standardized LaTeX syntax patterns (`$$...$$`, `\int_`, `\sum_`, `\prod_`, `\begin{matrix}`) identify deep analytical or proof tasks, routing to the pro tier.
   - **Code & Syntax Structure**: Markdown code fence ratio (` ``` `), universal programming punctuation density (`{};=>:[]`), and common programming language tokens (`class`, `def`, `func`, `SELECT`).
   - **Universal Technical Standard Acronyms**: International technical abbreviations that remain unchanged across languages (`2PC`, `Saga`, `Raft`, `Kafka`, `Redis`, `Kubernetes`, `JWT`).
   - **Protocol-Level Schema Constraints**: Detection of OpenAI `response_format: json_object`, `json_schema`, and `tools` flags immediately classifies requests as structured tasks and activates static validation.
3. **Externalized Domain Rule Customization**:
   - Domain-specific routing patterns can be supplied dynamically via regex rules in `config.yaml`, ensuring core router source code remains 100% language-neutral.

## Consequences
- **Positive**:
  - Full i18n compliance across arbitrary human languages.
  - Sub-millisecond execution: feature extraction relies on quick string and character-level statistics.
  - Clear separation of concerns between engine logic and business domain rules.
- **Negative / Limitations**:
  - Complex natural language thinking lacking formal syntax or formulas cannot be evaluated by shallow statistics alone; this necessitates hierarchical classification (ADR-0004 & ADR-0005).
