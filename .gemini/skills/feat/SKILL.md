---
name: feat
description: "Implement a new feature with comprehensive testing and quality checks. Use when asked to add a specific feature (e.g., 'feat: Add year tag...')."
---

# Feature Implementation Workflow

This skill guides the implementation of new features, ensuring they meet the project's high standards for code quality and test coverage.

## Workflow Steps

1. **Understand & Plan**: Analyze the feature request. Identify affected models, services, and API routes.
2. **Implement**: Write the code following existing project patterns and conventions.
3. **Test**: Create or update tests to achieve full coverage.
   - Refer to [testing_standards.md](references/testing_standards.md) for organizational and technical standards.
   - Focus on feature-based organization and covering AJAX, caching, and error paths.
4. **Lint & Type Check**:
   - Run `ruff check . --fix` to ensure code style compliance.
   - Run `mypy .` to verify type safety.
5. **Verify**: Run the full test suite using `scripts/tests.sh` to ensure no regressions and that the new feature works as expected.

## Quality Checklist

- [ ] Feature implemented according to requirements.
- [ ] Tests follow the naming and structure in `references/testing_standards.md`.
- [ ] AJAX/JSON response branches are covered.
- [ ] Caching logic is verified if applicable.
- [ ] Ruff issues are fixed.
- [ ] Mypy passes without errors.
- [ ] `scripts/tests.sh` passes all tests.
