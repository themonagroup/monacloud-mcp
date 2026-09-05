function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(value),
    json: async () => value,
  };
}

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url));
  if (parsed.pathname === '/realms/mona/.well-known/openid-configuration') {
    return response({
      issuer: 'https://id.test/realms/mona',
      userinfo_endpoint: 'https://id.test/realms/mona/protocol/openid-connect/userinfo',
    });
  }
  if (parsed.pathname === '/realms/mona/protocol/openid-connect/userinfo') {
    if (init.headers?.Authorization !== 'Bearer fake-token-for-test') {
      return response({ code: 'invalid_token' }, 401);
    }
    return response({ sub: 'user-123', email: 'mon@example.test', name: 'Mon' });
  }
  return response({ code: 'not_found' }, 404);
};
