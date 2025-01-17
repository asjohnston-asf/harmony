import { expect } from 'chai';
import { describe, it } from 'mocha';
import hookServersStartStop from './helpers/servers';
import { hookGetHealth, hookGetAdminHealth } from './helpers/health';
import { hookDatabaseFailure } from './helpers/db';

const healthyResponse = {
  status: 'up',
  message: 'Harmony is operating normally.',
  components: [{
    name: 'db',
    status: 'up',
  }],
};

const databaseDownHealthResponse = {
  status: 'down',
  message: 'Harmony is currently down.',
  components: [{
    name: 'db',
    status: 'down',
    message: 'Unable to query the database',
  }],
};

describe('Health endpoints', function () {
  hookServersStartStop({ USE_EDL_CLIENT_APP: true });

  describe('When calling /health', function () {
    describe('When not authenticated', function () {
      describe('When the system is healthy', function () {
        hookGetHealth();
        it('returns a 200 status code', function () {
          expect(this.res.statusCode).to.equal(200);
        });
        it('returns a healthy response', function () {
          const body = JSON.parse(this.res.text);
          expect(body).to.eql(healthyResponse);
        });
      });
      describe('When the database catches fire', function () {
        hookDatabaseFailure();
        hookGetHealth();
        it('returns a 503 status code', function () {
          expect(this.res.statusCode).to.equal(503);
        });
        it('returns a healthy response', function () {
          const body = JSON.parse(this.res.text);
          expect(body).to.eql(databaseDownHealthResponse);
        });
      });
    });
  });

  describe('When calling /admin/health', function () {
    describe('When not authenticated', function () {
      hookGetAdminHealth();
      it('redirects to Earthdata Login', function () {
        expect(this.res.statusCode).to.equal(303);
        expect(this.res.headers.location).to.include(process.env.OAUTH_HOST);
      });
    });

    describe('When authenticated as a regular user', function () {
      hookGetAdminHealth({ username: 'joe' });
      it('returns a 403', function () {
        expect(this.res.statusCode).to.equal(403);
      });
      it('returns a JSON message indicating not authorized', function () {
        const response = JSON.parse(this.res.text);
        expect(response).to.eql({ code: 'harmony.ForbiddenError', description: 'Error: You are not permitted to access this resource' });
      });
    });
  });

  describe('When authenticated as an admin user', function () {
    describe('When the system is healthy', function () {
      hookGetAdminHealth({ username: 'adam' });
      it('returns a 200 status code', function () {
        expect(this.res.statusCode).to.equal(200);
      });
      it('returns a healthy response', function () {
        const body = JSON.parse(this.res.text);
        expect(body).to.eql(healthyResponse);
      });
    });
    describe('When the database catches fire', function () {
      hookDatabaseFailure();
      hookGetAdminHealth({ username: 'adam' });
      it('returns a 503 status code', function () {
        expect(this.res.statusCode).to.equal(503);
      });
      it('returns a healthy response', function () {
        const body = JSON.parse(this.res.text);
        expect(body).to.eql(databaseDownHealthResponse);
      });
    });
  });
});