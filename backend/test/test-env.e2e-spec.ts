import {
  APP_ROLE,
  OWNER_ROLE,
  TEST_DATABASE,
  assertTestDatabaseUrl,
} from './test-env';

// The guard that keeps the E2E reset away from the development and
// production databases.
describe('E2E environment guard', () => {
  const url = (user: string, host: string, db: string) =>
    `postgresql://${user}:secret@${host}:5433/${db}?schema=public`;

  it.each([
    ['app', url(APP_ROLE, 'localhost', TEST_DATABASE), APP_ROLE],
    ['owner', url(OWNER_ROLE, '127.0.0.1', TEST_DATABASE), OWNER_ROLE],
  ])('accepts the local test database as %s', (_label, raw, role) => {
    expect(() => assertTestDatabaseUrl('X', raw, role)).not.toThrow();
  });

  const testUrl = url(OWNER_ROLE, 'localhost', TEST_DATABASE);

  it.each([
    ['unset', undefined, /not set/],
    ['not a URL', 'nope', /not a valid URL/],
    [
      'another protocol',
      testUrl.replace('postgresql:', 'mysql:'),
      /protocol|postgresql/,
    ],
    // node-postgres connects to ?host= / ?user= instead of the URL's own.
    ['a ?host= override', `${testUrl}&host=db.prod.example`, /host/],
    ['a ?user= override', `${testUrl}&user=spaceproof`, /user/],
    ['a ?database= override', `${testUrl}&database=spaceproof`, /database/],
    ['a socket ?host=', `${testUrl}&host=%2Fvar%2Frun`, /host/],
    [
      'a ?options= override',
      `${testUrl}&options=-c%20search_path%3Dx`,
      /options/,
    ],
    // With credentials the URL parser itself rejects an empty host.
    [
      'a socket URL without host',
      `postgresql://${OWNER_ROLE}:secret@/${TEST_DATABASE}`,
      /not a valid URL|localhost/,
    ],
    ['an empty host', `postgresql:///${TEST_DATABASE}`, /localhost/],
    [
      'the dev database',
      url(OWNER_ROLE, 'localhost', 'spaceproof'),
      /database/,
    ],
    [
      'the shadow database',
      url(OWNER_ROLE, 'localhost', 'spaceproof_shadow'),
      /database/,
    ],
    [
      'a remote host',
      url(OWNER_ROLE, 'db.example.com', TEST_DATABASE),
      /localhost/,
    ],
    [
      'the admin role',
      url('spaceproof', 'localhost', TEST_DATABASE),
      /connect as/,
    ],
    [
      'the app role as owner',
      url(APP_ROLE, 'localhost', TEST_DATABASE),
      /connect as/,
    ],
  ])('rejects %s without leaking the URL', (_label, raw, message) => {
    expect(() => assertTestDatabaseUrl('X', raw, OWNER_ROLE)).toThrow(message);
    try {
      assertTestDatabaseUrl('X', raw, OWNER_ROLE);
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });
});
