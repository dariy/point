# Auth.py Coverage Deep Dive

## Current: 67% Coverage (18 lines missing)

### Uncovered Lines Analysis

#### Lines 61-62: No User in System (Single-User Mode)
```python
61:     if not target_user:
62:         raise HTTPException(
```

**Path**: Login without username → `get_first_user()` returns None
**Current Test**: `test_login_no_users_in_database` - PASSES but doesn't hit this line
**Issue**: Test might be hitting a different error path first
**Solution**: Verify this path with detailed logging or mock `get_first_user` to return None

#### Lines 71-72: Authentication Failed
```python
71:     if not user:
72:         raise HTTPException(
```

**Path**: After `authenticate_user()` returns None (invalid credentials)
**Current Tests**: `test_login_with_username_wrong_password`, `test_login_single_user_mode_wrong_password`
**Issue**: These pass but don't trigger line 71-72
**Reason**: Might be hitting line 61-62 instead, or authentication is succeeding when it shouldn't
**Solution**: Mock `authenticate_user` to return None explicitly

#### Lines 86-101: Cookie Setting Logic
```python
86:     max_age = (
87:         settings.session_expiry_hours * 3600
88:         if login_data.remember_me
89:         else None  # Session cookie
90:     )
91:
92:     response.set_cookie(
93:         key=SESSION_COOKIE_NAME,
94:         value=plain_token,
95:         max_age=max_age,
96:         httponly=True,
97:         secure=settings.force_https and settings.app_env == "production",
98:         samesite="lax",
99:     )
100:
101:     return LoginResponse(
```

**Path**: Successful login → cookie is set
**Current Tests**: All login tests should hit this
**Issue**: ENTIRE block marked as uncovered - suspicious
**Possible Causes**:
1. Branch coverage issue (line 97: `settings.force_https and settings.app_env == "production"`)
2. Tests not actually completing successful login
3. `remember_me` branches (True/False) not both tested

**Solution**:
- Test with `remember_me=True` AND `remember_me=False`
- Test in production mode to hit `secure=True` branch
- Verify login actually succeeds

#### Lines 173-179: Password Change Failure
```python
173:     if not success:
174:         raise HTTPException(
175:             status_code=status.HTTP_400_BAD_REQUEST,
176:             detail="Current password is incorrect",
177:         )
178:
179:     return MessageResponse(message="Password changed successfully")
```

**Path**: `change_password()` returns `success=False`
**Current Test**: `test_change_password_incorrect_current` - returns 422 instead
**Issue**: Not reaching this code path; getting validation error (422) before this check
**Solution**: Mock or setup scenario where validation passes but password check fails

#### Lines 196-204: Session List Construction
```python
196:     session_responses = []
197:     for s in sessions:
198:         session_response = SessionResponse.model_validate(s)
199:         session_response.is_current = (
200:             current_session is not None and s.id == current_session.id
201:         )
202:         session_responses.append(session_response)
203:
204:     return SessionListResponse(
```

**Path**: List sessions endpoint with actual sessions
**Current Test**: `test_list_sessions_current_identification` - should cover this
**Issue**: Loop not executed or `current_session is None` branch not tested
**Solution**:
- Ensure test creates actual sessions in DB
- Test both with and without current_session
- Verify sessions list is non-empty

#### Lines 230, 250: Other Error Cases
Need to read these lines to understand what they are.

## Test Strategy

### Priority 1: Fix Existing Tests
1. Add assertions to verify code paths are actually hit
2. Add debug logging to trace execution
3. Use coverage in debug mode to see which branches are missed

### Priority 2: Add Mocking Tests
Use `unittest.mock` or `pytest-mock` to force specific return values:
```python
@patch('app.services.auth_service.AuthService.get_first_user')
async def test_no_user_in_system_mocked(mock_get_first_user, client):
    mock_get_first_user.return_value = None
    # Now test will definitely hit lines 61-62
```

### Priority 3: Branch Coverage
Ensure all conditional branches are tested:
- `remember_me=True` AND `False`
- `current_session is not None` AND `is None`
- Production mode AND development mode
- With username AND without username

## Next Actions

1. ✅ Read lines 230 and 250 to understand context
2. ✅ Add mock-based tests to force specific paths
3. ✅ Run coverage with branch details (`--cov-branch`)
4. ✅ Verify each test hits its target lines
