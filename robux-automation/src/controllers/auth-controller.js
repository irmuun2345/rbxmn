const crypto = require('crypto');

class AuthController {
  constructor(dbHelpers, RobloxAuth) {
    this.dbHelpers = dbHelpers;
    this.RobloxAuth = RobloxAuth;
    this.oauthGrants = new Map();
  }

  getSession(sessionId) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getSessionById(sessionId, (err, session) => {
        if (err) reject(err);
        else resolve(session);
      });
    });
  }

  saveSession(sessionId, userId, sessionData, expiresAt) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.createSession(
        sessionId,
        userId,
        JSON.stringify(sessionData),
        expiresAt,
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
    });
  }

  getUserByRobloxId(robloxId) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.getUserByRobloxId(robloxId, (err, user) => {
        if (err) reject(err);
        else resolve(user);
      });
    });
  }

  createUser(username, robloxId) {
    return new Promise((resolve, reject) => {
      this.dbHelpers.createUser(username, robloxId, (err, user) => {
        if (err) reject(err);
        else resolve(user);
      });
    });
  }

  renderOAuthResult(res, successful) {
    // This page is built here rather than served from public/, so it misses
    // the nonce stamper and has to carry the value itself. A nonce is also
    // why the close button binds its handler in a script block instead of an
    // onclick attribute — inline handlers can't be nonced, and allowing them
    // would mean allowing 'unsafe-inline' site-wide.
    const nonce = (res.locals && res.locals.cspNonce) || '';
    const title = successful ? 'Аккаунт баталгаажлаа' : 'Баталгаажуулалт амжилтгүй';
    const message = successful
      ? 'Roblox аккаунт амжилттай холбогдлоо. Энэ цонхыг хаагаад үндсэн дэлгэц рүү буцна уу.'
      : 'Хүсэлтийг баталгаажуулж чадсангүй. Үндсэн дэлгэцээс шинэ QR код үүсгээд дахин оролдоно уу.';

    return res.status(successful ? 200 : 400).type('html').send(`<!doctype html>
<html lang="mn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #17162f; color: #fff; }
    main { width: min(34rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid #817df7; border-radius: 1.5rem; background: #232146; box-sizing: border-box; }
    p { color: #c5c3df; line-height: 1.65; }
    button { border: 0; border-radius: .8rem; padding: .85rem 1.1rem; font-weight: 800; cursor: pointer; background: #ffd651; color: #17162f; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <button type="button" id="close-window">Цонх хаах</button>
  </main>
  <script nonce="${nonce}">
    document.getElementById('close-window').addEventListener('click', () => window.close());
  </script>
</body>
</html>`);
  }

  async generateQRCode(req, res) {
    try {
      const sessionId = crypto.randomBytes(24).toString('base64url');
      const state = `${sessionId}.${crypto.randomBytes(32).toString('base64url')}`;
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      const redirectUri = `${requestOrigin}/auth/roblox/callback`;
      const oauthRequest = await this.RobloxAuth.createOAuthRequest({ state, redirectUri });
      const expiresAt = Date.now() + 10 * 60 * 1000;

      await this.saveSession(sessionId, null, {
        status: 'pending',
        state,
        codeVerifier: oauthRequest.codeVerifier,
        redirectUri: oauthRequest.redirectUri
      }, expiresAt);

      res.json({
        success: true,
        sessionId,
        qrCode: oauthRequest.qrCode,
        authorizationUrl: oauthRequest.authorizationUrl,
        expiresIn: 600
      });
    } catch (error) {
      if (error.code !== 'ROBLOX_OAUTH_NOT_CONFIGURED') {
        console.error('QR code generation error:', error);
      }
      res.status(error.code === 'ROBLOX_OAUTH_NOT_CONFIGURED' ? 503 : 500).json({
        success: false,
        error: error.code === 'ROBLOX_OAUTH_NOT_CONFIGURED'
          ? error.message
          : 'Roblox баталгаажуулалтын хүсэлт үүсгэж чадсангүй.'
      });
    }
  }

  async checkAuthStatus(req, res) {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          error: 'Session ID шаардлагатай.'
        });
      }

      const session = await this.getSession(sessionId);

      if (!session) {
        return res.status(404).json({
          success: false,
          status: 'expired',
          error: 'QR код хүчингүй болсон эсвэл хугацаа дууссан.'
        });
      }

      const sessionData = JSON.parse(session.session_data);

      if (sessionData.status === 'authenticated') {
        // This endpoint converts a session id into a logged-in session, which
        // makes that id a bearer credential — and it travels in a URL path,
        // so it lands in access logs, browser history and proxy logs. Left
        // reusable it stayed valid for ten minutes, and anyone who read it
        // out of any of those places could replay it for the account.
        //
        // So it is spent on first use. The exception is the browser that
        // already holds the resulting session: a duplicate in-flight poll or
        // a refresh must not lock the real user out of their own login.
        const alreadySignedIn = req.session.userId === sessionData.localUserId;
        if (sessionData.consumed && !alreadySignedIn) {
          return res.status(410).json({
            success: false,
            status: 'expired',
            error: 'Энэ QR код аль хэдийн ашиглагдсан. Шинэ QR код үүсгэнэ үү.'
          });
        }

        const grant = this.oauthGrants.get(sessionId);

        // The storefront polls this endpoint every couple of seconds while
        // the QR is on screen, so the session id is only rotated on the one
        // poll that actually signs the user in. Regenerating on every poll
        // would hand out a new cookie a dozen times per login.
        if (!req.session.userId) {
          // regenerate() empties req.session, so anything worth keeping has
          // to be read out first and written back after.
          await new Promise((resolve, reject) => {
            req.session.regenerate((error) => (error ? reject(error) : resolve()));
          });
        }

        if (grant && grant.expiresAt > Date.now()) {
          req.session.robloxAccessToken = grant.accessToken;
          req.session.robloxAccessTokenExpiresAt = grant.expiresAt;
          req.session.authorizedUniverseIds = grant.authorizedUniverseIds;
          this.oauthGrants.delete(sessionId);
        }

        req.session.userId = sessionData.localUserId;
        req.session.username = sessionData.username;
        const authorizedUniverseIds = req.session.authorizedUniverseIds || [];

        await new Promise((resolve, reject) => {
          req.session.save((error) => (error ? reject(error) : resolve()));
        });

        // Spend the handoff only once the login it produced is durably
        // stored. Doing it earlier would risk burning the code on a request
        // that then failed to save, stranding a user who did nothing wrong.
        if (!sessionData.consumed) {
          await this.saveSession(
            sessionId,
            sessionData.localUserId,
            { ...sessionData, consumed: true },
            Number(session.expires_at)
          );
        }

        return res.json({
          success: true,
          status: 'authenticated',
          userId: sessionData.robloxId,
          username: sessionData.username,
          authorizedUniverseIds,
          canCreatePass: Boolean(
            req.session.robloxAccessToken
            && req.session.robloxAccessTokenExpiresAt > Date.now()
            && authorizedUniverseIds.length
          )
        });
      }

      return res.json({
        success: true,
        status: sessionData.status,
        error: sessionData.error || undefined
      });
    } catch (error) {
      console.error('Auth status check error:', error);
      res.status(500).json({
        success: false,
        error: 'Аккаунтын төлөв шалгаж чадсангүй.'
      });
    }
  }

  async handleOAuthCallback(req, res) {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const sessionId = state.split('.')[0];

    try {
      if (!sessionId || !state) {
        return this.renderOAuthResult(res, false);
      }

      const session = await this.getSession(sessionId);
      if (!session) {
        return this.renderOAuthResult(res, false);
      }

      const sessionData = JSON.parse(session.session_data);
      const expectedState = Buffer.from(sessionData.state || '');
      const receivedState = Buffer.from(state);
      const validState = expectedState.length === receivedState.length
        && crypto.timingSafeEqual(expectedState, receivedState);

      if (!validState || sessionData.status !== 'pending') {
        return this.renderOAuthResult(res, false);
      }

      if (req.query.error || !code) {
        sessionData.status = 'rejected';
        sessionData.error = 'Roblox зөвшөөрөл цуцлагдсан.';
        await this.saveSession(sessionId, null, sessionData, Number(session.expires_at));
        return this.renderOAuthResult(res, false);
      }

      sessionData.status = 'processing';
      await this.saveSession(sessionId, null, sessionData, Number(session.expires_at));

      const profile = await this.RobloxAuth.exchangeAuthorizationCode({
        code,
        codeVerifier: sessionData.codeVerifier,
        redirectUri: sessionData.redirectUri
      });

      let user = await this.getUserByRobloxId(profile.robloxId);
      if (!user) {
        user = await this.createUser(profile.username, profile.robloxId);
      }

      this.oauthGrants.set(sessionId, {
        accessToken: profile.accessToken,
        expiresAt: profile.accessTokenExpiresAt,
        authorizedUniverseIds: profile.authorizedUniverseIds
      });

      await this.saveSession(sessionId, user.id, {
        status: 'authenticated',
        localUserId: user.id,
        robloxId: profile.robloxId,
        username: profile.username,
        displayName: profile.displayName,
        picture: profile.picture
      }, Date.now() + 10 * 60 * 1000);

      return this.renderOAuthResult(res, true);
    } catch (error) {
      console.error('Roblox OAuth callback error:', error.response?.data || error.message);

      if (sessionId) {
        try {
          const session = await this.getSession(sessionId);
          if (session) {
            const sessionData = JSON.parse(session.session_data);
            sessionData.status = 'error';
            sessionData.error = 'Roblox баталгаажуулалт дууссангүй.';
            await this.saveSession(sessionId, null, sessionData, Number(session.expires_at));
          }
        } catch (sessionError) {
          console.error('OAuth session update error:', sessionError.message);
        }
      }

      return this.renderOAuthResult(res, false);
    }
  }

  // Logout
  async logout(req, res) {
    try {
      req.session.destroy((error) => {
        if (error) {
          console.error('Logout error:', error);
          return res.status(500).json({
            success: false,
            error: 'Logout failed'
          });
        }

        res.json({
          success: true,
          message: 'Logout successful'
        });
      });
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Logout failed' 
      });
    }
  }
}

module.exports = AuthController;
