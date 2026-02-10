/**
 * Authentication JavaScript - Photo Blog Engine
 * Handles password hashing, login, and password changes
 */

(function () {
    'use strict';

    // ===========================
    // SHA-256 Hashing
    // ===========================

    /**
     * Pure JS SHA-256 implementation for non-secure contexts
     * Fallback for environments without crypto.subtle
     */
    function sha256_fallback(ascii) {
        function rightRotate(value, amount) {
            return (value >>> amount) | (value << (32 - amount));
        }
        var mathPow = Math.pow;
        var maxWord = mathPow(2, 32);
        var lengthProperty = 'length';
        var i, j;
        var result = '';
        var words = [];
        var asciiBitLength = ascii[lengthProperty] * 8;
        var hash = sha256_fallback.h = sha256_fallback.h || [];
        var k = sha256_fallback.k = sha256_fallback.k || [];
        var primeCounter = k[lengthProperty];
        var isComposite = {};
        for (var candidate = 2; primeCounter < 64; candidate++) {
            if (!isComposite[candidate]) {
                for (i = 0; i < 313; i += candidate) {
                    isComposite[i] = candidate;
                }
                hash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
                k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
            }
        }
        ascii += '\x80';
        while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
        for (i = 0; i < ascii[lengthProperty]; i++) {
            j = ascii.charCodeAt(i);
            if (j >> 8) return;
            words[i >> 2] |= j << ((3 - i) % 4) * 8;
        }
        words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
        words[words[lengthProperty]] = (asciiBitLength | 0);
        for (j = 0; j < words[lengthProperty]; j += 16) {
            var w = words.slice(j, j + 16);
            var oldHash = hash;
            hash = hash.slice(0, 8);
            for (i = 0; i < 64; i++) {
                var i2 = i + j;
                var w15 = w[i - 15], w2 = w[i - 2];
                var a = hash[0], e = hash[4];
                var temp1 = hash[7] + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] + (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0);
                var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
                hash = [(temp1 + temp2) | 0].concat(hash);
                hash[4] = (hash[4] + temp1) | 0;
            }
            for (i = 0; i < 8; i++) {
                hash[i] = (hash[i] + oldHash[i]) | 0;
            }
        }
        for (i = 0; i < 8; i++) {
            for (j = 3; j + 1; j--) {
                var b = (hash[i] >> (j * 8)) & 255;
                result += ((b < 16) ? 0 : '') + b.toString(16);
            }
        }
        return result;
    }

    /**
     * Hash a value using SHA-256
     * Uses Web Crypto API if available, falls back to pure JS implementation
     */
    async function hashValue(value) {
        if (window.crypto && crypto.subtle && window.TextEncoder) {
            const msgUint8 = new TextEncoder().encode(value);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
            // Fallback for non-secure contexts
            return sha256_fallback(value);
        }
    }

    // ===========================
    // Login Form Handler
    // ===========================

    function initLoginForm() {
        const loginForm = document.getElementById('login-form');
        if (!loginForm) return;

        loginForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const form = e.target;
            const formData = new FormData(form);
            const rawPassword = formData.get('name');
            const hashedName = await hashValue(rawPassword);

            const data = {
                name: hashedName,
                remember_me: formData.get('remember') === '1'
            };

            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data),
                    credentials: 'include'
                });

                if (response.ok) {
                    window.location.href = '/light/';
                } else {
                    const error = await response.json();
                    const errorDiv = document.querySelector('.login-error');
                    if (errorDiv) {
                        errorDiv.textContent = error.detail || 'Invalid credentials';
                        errorDiv.classList.add('visible-block');
                    } else {
                        const newError = document.createElement('div');
                        newError.className = 'login-error';
                        newError.textContent = error.detail || 'Invalid credentials';
                        form.insertBefore(newError, form.firstChild);
                    }
                }
            } catch (error) {
                console.error('Login error:', error);
                alert('An error occurred. Please try again.');
            }
        });
    }

    // ===========================
    // Password Change Form Handler
    // ===========================

    function initPasswordForm() {
        const passwordForm = document.getElementById('password-form');
        if (!passwordForm) return;

        passwordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const saveBtn = form.querySelector('button[type="submit"]');
            const status = document.getElementById('password-status');

            if (saveBtn.disabled) return;

            const currentPassword = form.current_name.value;
            const newPassword = form.new_name.value;
            const confirmPassword = form.confirm_name.value;

            if (newPassword !== confirmPassword) {
                status.textContent = 'Error: New passwords do not match';
                status.className = 'save-status error';
                return;
            }

            saveBtn.disabled = true;
            status.textContent = 'Updating...';
            status.className = 'save-status';

            try {
                const hashedCurrent = await hashValue(currentPassword);
                const hashedNew = await hashValue(newPassword);

                const response = await fetch('/api/auth/change-password', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        current_name: hashedCurrent,
                        new_name: hashedNew
                    }),
                });

                if (response.ok) {
                    status.textContent = 'Password updated successfully!';
                    status.className = 'save-status success';
                    form.reset();
                    if (window.LightUtils && window.LightUtils.showToast) {
                        window.LightUtils.showToast('Password updated successfully!');
                    }
                    setTimeout(() => {
                        if (status.textContent === 'Password updated successfully!') {
                            status.textContent = '';
                        }
                    }, 3000);
                } else {
                    const data = await response.json();
                    const errorMsg = data.detail || 'Failed to update password';
                    status.textContent = 'Error: ' + errorMsg;
                    status.className = 'save-status error';
                    if (window.LightUtils && window.LightUtils.showToast) {
                        window.LightUtils.showToast(errorMsg, 'error');
                    }
                }
            } catch (error) {
                console.error('Password change error caught:', error);
                status.textContent = 'Error: ' + error.message;
                status.className = 'save-status error';
            } finally {
                saveBtn.disabled = false;
            }
        });
    }

    // ===========================
    // Initialize
    // ===========================

    function init() {
        initLoginForm();
        initPasswordForm();
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
