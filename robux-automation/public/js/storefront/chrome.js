// Entry point for the pages whose only behaviour is the chrome itself:
// /giftcards and /faq. Everything on them is in the markup, which is the
// point — they read fine with no JavaScript at all, and this only adds the
// bell's dot, the session check and the sign-in sheet.

import { initShell } from './shell.js';

initShell();
