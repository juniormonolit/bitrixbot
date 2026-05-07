# Настройка агентов Cursor под проект

Скопируй нужный промпт ниже и вставь в чат Cursor.

---

## 1. Настройка test-writer

По умолчанию `test-writer` универсальный — он сам определяет стек и соглашения по существующим тестам в проекте. Но если хочешь зафиксировать конкретные инструкции (фреймворк, структура, моки), запусти этот промпт один раз. Агент добавит секцию `## Project-Specific Instructions` в начало `.cursor/agents/test-writer.md`, и при следующих вызовах он будет следовать именно ей, а не автоопределению.

```
Scan this project and configure the test-writer agent for it.

Steps:
1. Detect the tech stack by checking:
   - package.json (dependencies, devDependencies)
   - tsconfig.json (TypeScript)
   - pyproject.toml / setup.py / requirements.txt
   - go.mod
   - Cargo.toml
   - pom.xml / build.gradle
   - Gemfile
   - composer.json

2. Find the test framework in use:
   - JS/TS: look for jest, vitest, mocha, @testing-library/* in package.json
   - Python: look for pytest, unittest in requirements / pyproject.toml
   - Go: check go.mod for github.com/stretchr/testify
   - Rust: check Cargo.toml dev-dependencies
   - Java: check pom.xml / build.gradle for junit, mockito
   - Ruby: check Gemfile for rspec or minitest
   - PHP: check composer.json for phpunit

3. Check if any test files exist in the project:
   - Look for files matching: *.test.ts, *.spec.ts, *.test.js, *.spec.js,
     test_*.py, *_test.py, *_test.go, *_test.rs, *_spec.rb

--- BRANCH A: Tests already exist ---

4a. Analyze existing test files to extract project conventions:
    - File naming pattern (*.test.ts vs *.spec.ts, test_*.py vs *_test.py, etc.)
    - File location (co-located with source vs tests/ / __tests__/ folder)
    - How mocks/stubs are set up (jest.mock, vi.mock, pytest fixtures, etc.)
    - Any shared test utilities, factories, or helpers used
    - Describe/it nesting depth (JS/TS), table-driven style (Go), etc.
    - Find 2-3 representative existing test files and read them

5a. Edit `.cursor/agents/test-writer.md`:
    - Add a new section at the very top of the file body (right after the frontmatter block):
      ## Project-Specific Instructions
      with the following content:
      - **Stack:** [language + framework detected]
      - **Test framework:** [exact framework and version if known]
      - **File naming:** [exact pattern, e.g. `*.test.ts`]
      - **File location:** [co-located / tests/ / __tests__/ etc.]
      - **Mock approach:** [how mocks are done in this project]
      - **Test utilities:** [list any shared helpers, fixtures, factories found]
      - **Example reference:** [path to 1-2 good existing test files to follow]
    - Keep the rest of the file intact

--- BRANCH B: No tests found ---

4b. Based on the detected stack, suggest 2-4 suitable test frameworks.
    For each option provide: name, install command, brief reason to choose it.
    Mark one option as ⭐ RECOMMENDED — the one that best fits this project's stack,
    ecosystem conventions, and complexity.

    Examples of recommendations by stack:
    - React/Next.js + TypeScript → ⭐ Vitest + @testing-library/react
      (faster than Jest, native ESM, same API, works with Vite out of the box)
    - Node.js backend (no bundler) → ⭐ Jest or ⭐ Vitest
    - Python → ⭐ pytest (standard, rich ecosystem)
    - Go → ⭐ built-in testing + testify
    - Rust → ⭐ built-in #[cfg(test)]

5b. Ask the user:
    "No tests found in this project. Here are the options for setting up testing:

    [list the options with ⭐ on recommended]

    Would you like me to set up one of these? Reply with the number or name,
    or 'no' to skip and just configure the agent with defaults."

6b. If the user confirms a choice:
    - Install the necessary packages (e.g. npm install -D vitest @testing-library/react)
    - Create a minimal config file if needed (vitest.config.ts, jest.config.ts, pytest.ini, etc.)
    - Add test script to package.json (or equivalent) if missing
    - Create one minimal example test file so the agent has a convention to follow
    - Then proceed to edit `.cursor/agents/test-writer.md` as in step 5a,
      using the newly installed framework as the source of truth

Show me what you find before making any edits, so I can confirm.
```

---

## 2. Настройка test-runner

Агент просканирует структуру проекта и обновит `.cursor/agents/test-runner.md` — заменит дженерик-примеры на реальные команды для этого проекта.

```
Scan this project and configure the test-runner agent for it.

Steps:
1. Detect the tech stack by checking:
   - package.json (scripts: test, lint, typecheck, build)
   - pyproject.toml / setup.py / requirements.txt
   - go.mod
   - Cargo.toml
   - Gemfile
   - composer.json
   - Makefile (look for `test`, `lint`, `check` targets)
   - Any CI config: .github/workflows/, .gitlab-ci.yml, Jenkinsfile

2. Find test infrastructure:
   - Test runner: jest, vitest, pytest, go test, cargo test, rspec, phpunit, etc.
   - Test directories: tests/, __tests__/, test/, spec/
   - Test file patterns: *.test.ts, *_test.go, test_*.py, *_spec.rb
   - Coverage commands if configured

3. Find linting/static analysis:
   - JS/TS: eslint, biome, oxlint (check package.json scripts + config files .eslintrc*, biome.json)
   - Python: ruff, pylint, flake8, mypy (check pyproject.toml, setup.cfg, ruff.toml)
   - Go: golangci-lint (check .golangci.yml)
   - Rust: cargo clippy, cargo fmt --check
   - Ruby: rubocop
   - PHP: phpcs, phpstan, psalm
   - Type checking: tsc --noEmit, mypy, pyright

4. Check how to run only specific files/packages (not the whole suite):
   - e.g. `jest path/to/file`, `pytest tests/unit/test_foo.py`, `go test ./pkg/auth/...`

5. Edit `.cursor/agents/test-runner.md`:
   - Replace the generic auto-detect examples in sections "Linter Checks" and "Run Tests"
     with the EXACT commands for this project
   - Add a new section at the top (after the frontmatter block) called:
     ## Project-Specific Commands
     with the concrete commands grouped by category (lint, typecheck, test all, test single file/package, coverage)
   - Keep the rest of the file intact

Show me what you find before editing, so I can confirm.
```
