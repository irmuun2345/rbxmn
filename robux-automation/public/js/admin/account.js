// The admin's own account: who is signed in, changing the password, and
// signing out.

import { $, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';

// Doubles as the session check for the whole page: a 401 here means the
// cookie is gone or expired, and main.js sends the browser to the login page.
export async function loadAdminProfile() {
  const data = await request('/admin/profile');
  $('admin-username').textContent = data.profile.username;
}

export function initAccount() {
  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = event.submitter;
    setLoading(button, true, 'Хадгалж байна…');
    try {
      await request('/admin/password', jsonBody('PUT', {
        currentPassword: $('current-password').value,
        newPassword: $('new-password').value
      }), 'Нууц үг шинэчлэгдсэнгүй.');
      // Clears both fields, so neither password is left sitting in the DOM.
      form.reset();
      showResult($('password-result'), 'Админы нууц үг шинэчлэгдлээ.');
    } catch (error) {
      showResult($('password-result'), error.message, true);
    } finally {
      setLoading(button, false);
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    try {
      await request('/admin/logout', { method: 'POST' });
    } finally {
      // Leaves regardless: if the request failed the cookie may still be
      // valid, but the person at the keyboard asked to be gone from this
      // screen, so the screen goes.
      window.location.replace('/admin-login.html');
    }
  });
}
