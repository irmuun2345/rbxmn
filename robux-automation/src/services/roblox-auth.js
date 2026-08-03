const crypto = require('crypto');
const axios = require('axios');
const QRCode = require('qrcode');

const AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
const TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';
const TOKEN_RESOURCES_URL = 'https://apis.roblox.com/oauth/v1/token/resources';
const GAME_PASSES_URL = 'https://apis.roblox.com/game-passes/v1/universes';
const INVENTORY_URL = 'https://apis.roblox.com/cloud/v2/users';

class RobloxAuth {
  static getOAuthConfig(redirectUri) {
    const clientId = process.env.ROBLOX_OAUTH_CLIENT_ID;
    const clientSecret = process.env.ROBLOX_OAUTH_CLIENT_SECRET;
    const configuredRedirectUri = process.env.ROBLOX_OAUTH_REDIRECT_URI || redirectUri;

    if (!clientId || !clientSecret || !configuredRedirectUri) {
      const missing = [
        !clientId && 'ROBLOX_OAUTH_CLIENT_ID',
        !clientSecret && 'ROBLOX_OAUTH_CLIENT_SECRET',
        !configuredRedirectUri && 'ROBLOX_OAUTH_REDIRECT_URI'
      ].filter(Boolean);
      const error = new Error(
        `Roblox OAuth тохиргоо дутуу: ${missing.join(', ')}. config/.env файлыг тохируулна уу.`
      );
      error.code = 'ROBLOX_OAUTH_NOT_CONFIGURED';
      throw error;
    }

    return { clientId, clientSecret, redirectUri: configuredRedirectUri };
  }

  static async createOAuthRequest({ state, redirectUri }) {
    const config = this.getOAuthConfig(redirectUri);
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const authorizationUrl = new URL(AUTHORIZE_URL);
    authorizationUrl.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: 'openid profile game-pass:write',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state
    }).toString();

    return {
      authorizationUrl: authorizationUrl.toString(),
      codeVerifier,
      redirectUri: config.redirectUri,
      qrCode: await QRCode.toDataURL(authorizationUrl.toString(), {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 360
      })
    };
  }

  static async exchangeAuthorizationCode({ code, codeVerifier, redirectUri }) {
    const config = this.getOAuthConfig(redirectUri);
    const tokenBody = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier
    });

    const tokenResponse = await axios.post(TOKEN_URL, tokenBody.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    if (!tokenResponse.data?.access_token) {
      throw new Error('Roblox access token буцаасангүй.');
    }

    const userResponse = await axios.get(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
      timeout: 15000
    });
    const profile = userResponse.data;

    if (!profile?.sub || !profile?.preferred_username) {
      throw new Error('Roblox хэрэглэгчийн баталгаажсан мэдээлэл дутуу байна.');
    }

    const resourceBody = new URLSearchParams({
      token: tokenResponse.data.access_token,
      client_id: config.clientId,
      client_secret: config.clientSecret
    });
    const resourcesResponse = await axios.post(
      TOKEN_RESOURCES_URL,
      resourceBody.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      }
    );
    const authorizedUniverseIds = [
      ...new Set(
        (resourcesResponse.data?.resource_infos || [])
          .flatMap((resourceInfo) => resourceInfo.resources?.universe?.ids || [])
          .map(String)
      )
    ];
    const expiresIn = Number(tokenResponse.data.expires_in || 900);

    return {
      robloxId: String(profile.sub),
      username: profile.preferred_username,
      displayName: profile.name || profile.nickname || profile.preferred_username,
      picture: profile.picture || null,
      accessToken: tokenResponse.data.access_token,
      accessTokenExpiresAt: Date.now() + expiresIn * 1000,
      authorizedUniverseIds
    };
  }

  static async createGamePass({ accessToken, universeId, name, description, price }) {
    const form = new FormData();
    form.append('name', name);
    form.append('description', description);
    form.append('isForSale', 'true');
    form.append('price', String(price));
    form.append('isManagedPricingEnabled', 'false');

    const response = await axios.post(
      `${GAME_PASSES_URL}/${encodeURIComponent(universeId)}/game-passes`,
      form,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000
      }
    );
    const gamePassId = response.data?.gamePassId;

    if (!gamePassId) {
      throw new Error('Roblox Game Pass ID буцаасангүй.');
    }

    return {
      gamePassId: String(gamePassId),
      name: response.data.name || name,
      price
    };
  }

  static async verifySellerOwnsGamePass(gamePassId) {
    const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
    const sellerUserId = process.env.ROBLOX_SELLER_USER_ID;

    if (!apiKey || !/^\d+$/.test(sellerUserId || '')) {
      const error = new Error(
        'ROBLOX_OPEN_CLOUD_API_KEY болон ROBLOX_SELLER_USER_ID тохиргоо шаардлагатай.'
      );
      error.code = 'ROBLOX_INVENTORY_NOT_CONFIGURED';
      throw error;
    }

    const response = await axios.get(
      `${INVENTORY_URL}/${encodeURIComponent(sellerUserId)}/inventory-items`,
      {
        headers: { 'x-api-key': apiKey },
        params: {
          filter: `gamePassIds=${gamePassId}`,
          maxPageSize: 10
        },
        timeout: 15000
      }
    );

    return {
      sellerUserId,
      owned: Array.isArray(response.data?.inventoryItems)
        && response.data.inventoryItems.length > 0
    };
  }

}

module.exports = RobloxAuth;
