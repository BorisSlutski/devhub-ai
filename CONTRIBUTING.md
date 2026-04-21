# Contributing to DevHub-AI

Thanks for your interest in contributing! DevHub-AI is an open-source project and we welcome pull requests from everyone.

## Getting Started

### Prerequisites

- **Node.js** 18+
- **npm** 9+
- **macOS** 10.15+ (DevHub-AI is a macOS Electron app)

### Setup

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/devhub-ai.git
cd devhub-ai

# 2. Install dependencies
npm install

# 3. Start the dev server
npm run dev
```

## Making Changes

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```

2. **Make your changes** — keep commits focused and atomic.

3. **Run tests** before pushing:
   ```bash
   npm test
   ```

4. **Push** to your fork:
   ```bash
   git push origin feat/your-feature
   ```

5. **Open a Pull Request** against `main` on the upstream repo.

## Branch Naming

| Prefix   | Use for                        |
|----------|--------------------------------|
| `feat/`  | New features                   |
| `fix/`   | Bug fixes                      |
| `docs/`  | Documentation only             |
| `refactor/` | Code restructuring          |
| `test/`  | Adding or updating tests       |

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add recursive project scanning
fix: settings button unclickable in titlebar
docs: update README with new screenshots
```

## Pull Request Guidelines

- Fill out the PR template.
- Keep PRs small and focused — one feature or fix per PR.
- Include tests for new functionality when possible.
- Make sure all existing tests pass (`npm test`).
- Update documentation if your change affects user-facing behavior.

## Project Structure

```
src/
├── main/           # Electron main process (Node.js)
├── preload/        # Preload scripts (IPC bridge)
├── renderer/       # React UI (components, hooks)
└── shared/         # Shared types between main & renderer
```

## Code Style

- TypeScript throughout — no `any` unless absolutely necessary.
- Functional React components with hooks.
- No unnecessary comments — code should be self-documenting.

## Reporting Bugs

Open an [issue](https://github.com/BorisSlutski/devhub-ai/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- macOS version and DevHub-AI version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
