// The single way this front end talks to the server.
//
// Every endpoint answers `{ success: true, ... }` or `{ success: false,
// error }`, so one helper can turn both a transport failure and a refusal
// into the same thrown Error — which is what lets every call site collapse to
// try/catch around one line.
//
// `fallback` is what the user sees when the server sent no message of its
// own. Never surface `error.stack` or a raw status code: those describe the
// server, not what the person in front of the screen should do next.

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {string} [fallback] message shown when the server sent none
 * @returns {Promise<object>} the parsed body, guaranteed to have success:true
 */
export async function request(url, options, fallback = 'Хүсэлтийг гүйцэтгэж чадсангүй.') {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.error || fallback);
  return data;
}

// Builds the options object for a JSON-bodied request. Spelled out here once
// rather than at each of the thirty-odd call sites that need it.
export const jsonBody = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
