import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyList from '../anylist-js/lib/index.js';
import AnyListClient from '../src/anylist-client.js';

// Exercises AnyListClient.createList against anylist-js's real protobuf
// definitions, with a fake server standing in for the network.

function encodeUserData(protobuf, lists) {
  return new protobuf.PBUserDataResponse({
    shoppingListsResponse: { newLists: lists, listResponses: [] },
    starterListsResponse: {
      recentItemListsResponse: { listResponses: [] },
      favoriteItemListsResponse: { listResponses: [] },
    },
    mealPlanningCalendarResponse: { calendarId: 'cal-1' },
  }).toBuffer();
}

// form-data keeps each appended value as its own stream entry: [header, value, footer].
function decodeOperation(protobuf, body) {
  return protobuf.PBListOperationList.decode(body._streams[1]).operations[0];
}

async function setup({ applyCreate = true } = {}) {
  const anylist = new AnyList({ email: 'test@example.com', password: 'unused' });
  anylist.uid = 'user-1';
  const serverLists = [{ identifier: 'list-1', name: 'Shared Grocery List', items: [] }];
  const operations = [];
  anylist.client = {
    post: async (url, options) => {
      if (url === 'data/user-data/get') {
        return { body: encodeUserData(anylist.protobuf, serverLists) };
      }
      const op = decodeOperation(anylist.protobuf, options.body);
      operations.push({ url, op });
      if (applyCreate && op.metadata.handlerId === 'new-shopping-list') {
        serverLists.push({ identifier: op.list.identifier, name: op.list.name, items: [] });
      }
      return {};
    },
  };
  await anylist.getLists();

  const client = new AnyListClient({ username: 'u', password: 'p' });
  client.client = anylist;
  client.targetList = anylist.getListByName('Shared Grocery List');
  return { client, anylist, operations };
}

describe('createList', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await setup();
  });

  it('sends one new-shopping-list operation carrying the new list', async () => {
    await ctx.client.createList('Christmas List');
    assert.equal(ctx.operations.length, 1);
    const { url, op } = ctx.operations[0];
    assert.equal(url, 'data/shopping-lists/update');
    assert.equal(op.metadata.handlerId, 'new-shopping-list');
    assert.equal(op.metadata.userId, 'user-1');
    assert.equal(op.list.name, 'Christmas List');
    assert.equal(op.list.creator, 'user-1');
    assert.equal(op.listId, op.list.identifier);
    assert.match(op.list.identifier, /^[0-9a-f]{32}$/);
  });

  it('returns the new list once it reads back, and can then be connected to', async () => {
    const created = await ctx.client.createList('  Christmas List ');
    assert.equal(created.name, 'Christmas List');
    assert.deepEqual(ctx.client.getAvailableListNames(), ['Shared Grocery List', 'Christmas List']);
    assert.equal(ctx.client.targetList.name, 'Shared Grocery List');
    assert.equal(ctx.client.targetList, ctx.anylist.getListByName('Shared Grocery List'));
    await ctx.client.connect('Christmas List');
    assert.equal(ctx.client.targetList.identifier, created.identifier);
  });

  it('refuses a name that is already taken, without sending anything', async () => {
    await assert.rejects(ctx.client.createList('Shared Grocery List'), /already exists/);
    assert.equal(ctx.operations.length, 0);
  });

  it('refuses a blank name', async () => {
    await assert.rejects(ctx.client.createList('   '), /required/);
    assert.equal(ctx.operations.length, 0);
  });

  it('works with no list connected, as when no default list is configured', async () => {
    ctx.client.targetList = null;
    const created = await ctx.client.createList('Christmas List');
    assert.equal(created.name, 'Christmas List');
    assert.equal(ctx.client.targetList, null);
  });

  it('signs in on its own first, and stays signed out if sign-in fails', async () => {
    const login = AnyList.prototype.login;
    AnyList.prototype.login = async () => { throw new Error('bad password'); };
    try {
      const client = new AnyListClient({ username: 'u', password: 'p' });
      await assert.rejects(client.createList('Christmas List'), /bad password/);
      assert.equal(client.client, null);
    } finally {
      AnyList.prototype.login = login;
    }
  });

  it('fails when AnyList accepts the request but the list never appears', async () => {
    ctx = await setup({ applyCreate: false });
    await assert.rejects(ctx.client.createList('Christmas List'), /did not appear/);
  });
});
