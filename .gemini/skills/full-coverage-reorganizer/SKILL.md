---
name: full-coverage-reorganizer
description: Automates increasing Python test coverage to 100% and reorganizing tests by feature. Use when asked to boost coverage for a specific file and then organize the resulting tests.
---

# Full Coverage Reorganizer

This skill provides a standardized workflow for achieving 100% test coverage for a Python file and subsequently organizing the tests into a feature-based structure.

## Workflow

### Step 1: Increase Test Coverage to 100%

Use the `python-coverage-booster` skill to identify and fill coverage gaps for the target file.

1.  **Analyze Current Coverage**:
    - Reference `tests.md` for historical context and established patterns.
    - Run the initial coverage check:
      ```bash
      venv/bin/pytest tests/path/to/existing_tests.py --cov=app.path.to.target_file --cov-report=term-missing
      ```
2.  **Implement Coverage Tests**:
    - Choose a temporary test file: `tests/path/to/test_target_file_coverage.py`.
    - Implement tests targeting all missing lines and branches.
    - Ensure 100% coverage is achieved and verified.

### Step 2: Organize Tests by Feature

After achieving 100% coverage, apply the `organize-tests-by-feature` skill located at `.claude/skills/organize-tests-by-feature.md`.

1.  **Analyze Current Structure**: Review all test files in the directory containing the target file's tests.
2.  **Consolidate and Reorganize**:
    - Group tests by actual features (e.g., `test_tag_management.py`, `test_tag_discovery.py`).
    - Merge both service-layer and API-layer tests into these feature-based files.
    - Follow the naming convention: `test_<feature_name>.py`.
3.  **Clean Up**:
    - Remove inappropriately named or redundant files (e.g., the temporary coverage file).
    - Ensure all imports are at the top and correctly ordered.
4.  **Final Verification**:
    - Run `ruff` and `mypy` on all new/modified test files.
    - Run the entire test suite for the module to ensure no regressions and maintained 100% coverage.
