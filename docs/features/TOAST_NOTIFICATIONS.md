# Toast Notification System - Light Admin Interface

## Overview

The Light admin interface (`/light/*`) uses a centralized toast notification system for displaying user feedback messages. This provides a consistent, non-intrusive way to show success, error, warning, and info messages.

## Usage

### Basic Usage

Toast notifications are available via the `window.LightUtils.showToast()` function, which is exported from `/static/js/light.js`.

```javascript
// Success message (default)
window.LightUtils.showToast('Operation completed successfully!');

// Success message (explicit)
window.LightUtils.showToast('Settings saved!', 'success');

// Error message
window.LightUtils.showToast('Failed to save changes', 'error');

// Warning message
window.LightUtils.showToast('This action cannot be undone', 'warning');

// Info message
window.LightUtils.showToast('Processing your request...', 'info');
```

### Message Types

- **`success`** (default) - Green toast for successful operations
- **`error`** - Red toast for errors and failures
- **`warning`** - Yellow/orange toast for warnings
- **`info`** - Blue toast for informational messages

## Implementation Details

### Function Signature

```javascript
function showToast(message, type = 'success')
```

**Parameters:**
- `message` (string) - The text to display in the toast
- `type` (string, optional) - The type of toast: 'success', 'error', 'warning', or 'info'. Defaults to 'success'.

### Behavior

- Toasts appear in the top-right corner of the screen
- They automatically dismiss after 3 seconds
- Multiple toasts stack vertically
- Toasts fade out with a slide animation
- The container is created automatically if it doesn't exist

### CSS Classes

Toasts use the following CSS classes:
- `.flash-messages-container` - Container for all toasts
- `.flash-message` - Base class for individual toasts
- `.flash-success` - Success toast styling
- `.flash-error` - Error toast styling
- `.flash-warning` - Warning toast styling
- `.flash-info` - Info toast styling

## Best Practices

### ✅ DO Use Toasts For:

1. **Form Submissions**
   ```javascript
   // After saving settings
   window.LightUtils.showToast('Settings saved successfully!', 'success');
   ```

2. **AJAX Operations**
   ```javascript
   // After API call
   if (response.ok) {
       window.LightUtils.showToast('Post published!', 'success');
   } else {
       window.LightUtils.showToast('Failed to publish post', 'error');
   }
   ```

3. **User Actions**
   ```javascript
   // After deleting an item
   window.LightUtils.showToast('Media file deleted', 'success');
   ```

4. **Copy to Clipboard**
   ```javascript
   window.LightUtils.showToast('URL copied to clipboard', 'success');
   ```

5. **File Uploads**
   ```javascript
   window.LightUtils.showToast(`Uploaded: ${filename}`, 'success');
   ```

### ❌ DON'T Use Toasts For:

1. **Critical Errors** - Use modal dialogs instead
2. **Confirmations** - Use `window.LightUtils.confirm()` instead
3. **Long Messages** - Keep messages concise (< 60 characters)
4. **Persistent Information** - Use inline text or dedicated UI elements

## Migration from Inline Status Messages

### Before (Inline Status)
```javascript
const status = document.getElementById('save-status');
status.textContent = 'Settings saved successfully!';
status.className = 'save-status success';
setTimeout(() => {
    status.textContent = '';
}, 3000);
```

### After (Toast Notification)
```javascript
window.LightUtils.showToast('Settings saved successfully!', 'success');
```

## Availability Check

Always check if `LightUtils` is available before using:

```javascript
if (window.LightUtils && window.LightUtils.showToast) {
    window.LightUtils.showToast('Message here', 'success');
} else {
    // Fallback for older browsers or if light.js didn't load
    console.log('Message here');
}
```

## Examples from Codebase

### Settings Page (`/light/settings`)
```javascript
// Success
window.LightUtils.showToast('Settings saved successfully!', 'success');

// Error
window.LightUtils.showToast('Failed to save settings', 'error');
```

### Media Upload (`/light/media`)
```javascript
// Upload success
window.LightUtils.showToast(`Uploaded: ${file.name}`, 'success');

// Upload failure
window.LightUtils.showToast(`Failed to upload: ${file.name}`, 'error');

// Warning
window.LightUtils.showToast(`Skipped ${file.name}: Not an image, video, or audio file`, 'warning');
```

### Delete Operations
```javascript
// After successful deletion
window.LightUtils.showToast('Deleted successfully', 'success');

// After failed deletion
window.LightUtils.showToast('Failed to delete', 'error');
```

### Copy URL
```javascript
// After copying to clipboard
window.LightUtils.showToast('URL copied to clipboard', 'success');
window.LightUtils.showToast('Markdown copied to clipboard', 'success');
```

## System.js Modal Dialogs

For the `/light/system` page, use the built-in modal system for alerts and confirmations instead of toasts:

```javascript
// Alert dialog
await showAlert('Success', 'Backup created successfully!');

// Confirmation dialog
const confirmed = await showConfirm(
    'Delete Backup',
    'Are you sure you want to delete this backup?',
    'Delete',
    true  // isDanger
);
```

## Styling

Toast notifications inherit styling from the main Light CSS theme and automatically adapt to light/dark mode. The styles are defined in `/static/css/light.css`.

## Technical Notes

- Toasts are implemented as a self-contained IIFE in `light.js`
- The function is exported via `window.LightUtils` for global access
- The container is created on-demand and persists across page interactions
- Each toast is automatically removed from the DOM after the fade-out animation completes
- Z-index is set high enough to appear above all other UI elements

## Related Files

- `/app/static/js/light.js` - Toast implementation (lines 41-63)
- `/app/static/js/light-settings.js` - Example usage in settings page
- `/app/static/css/light.css` - Toast styling
- `/app/templates/light/base.html` - Base template that loads light.js
