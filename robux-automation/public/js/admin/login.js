// Admin login.
//
// The failure message is deliberately the same whether the username exists or
// the password was wrong: telling the two apart would turn this form into a
// username oracle. The server sends one message for both; this only displays
// it.

import { $, showResult, setLoading } from '../common/dom.js';
import { request, jsonBody } from '../common/api.js';

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  setLoading(button, true, 'Нэвтэрч байна…');

  try {
    await request('/admin/login', jsonBody('POST', {
      username: $('username').value.trim(),
      password: $('password').value
    }), 'Хэрэглэгчийн нэр эсвэл нууц үг буруу байна.');

    showResult($('login-result'), 'Нэвтэрлээ. Удирдлагын хэсгийг нээж байна…');
    window.location.assign('/admin.html');
  } catch (error) {
    showResult($('login-result'), error.message, true);
    setLoading(button, false);
  }
});
