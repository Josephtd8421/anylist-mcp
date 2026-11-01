import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import AnyList from '../anylist-js/lib/index.js';
import AnyListClient from '../src/anylist-client.js';

// Exercises AnyListClient's price handling against anylist-js's real protobuf
// definitions, with the network call captured instead of sent.

const LIST_ID = 'list-1';
const TJ = 'store-tj';
const ALDI = 'store-aldi';

function buildUserData(protobuf, items) {
  const response = new protobuf.PBUserDataResponse({
    shoppingListsResponse: {
      newLists: [{ identifier: LIST_ID, name: 'Shared Grocery List', items }],
      listResponses: [{
        listId: LIST_ID,
        stores: [
          { identifier: TJ, name: 'Trader Joes', listId: LIST_ID },
          { identifier: ALDI, name: 'Aldi', listId: LIST_ID },
        ],
      }],
    },
    starterListsResponse: {
      recentItemListsResponse: { listResponses: [] },
      favoriteItemListsResponse: { listResponses: [] },
    },
  });
  // Round-trip so the snapshot has the same shape a real decode gives.
  return protobuf.PBUserDataResponse.decode(response.toBuffer());
}

async function setup(items) {
  const anylist = new AnyList({ email: 'test@example.com', password: 'unused' });
  anylist.uid = 'user-1';
  anylist._userData = buildUserData(anylist.protobuf, items);
  const posts = [];
  anylist.client = { post: async (url, { body }) => { posts.push({ url, body }); } };
  await anylist.getLists(false);

  const client = new AnyListClient({ username: 'u', password: 'p' });
  client.client = anylist;
  client.targetList = anylist.getListByName('Shared Grocery List');
  return { client, anylist, posts };
}

// form-data keeps each appended value as its own stream entry: [header, value, footer].
function decodeOperation(anylist, post) {
  const buffer = post.body._streams[1];
  return anylist.protobuf.PBListOperationList.decode(buffer).operations[0];
}

describe('item prices', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await setup([
      { identifier: 'i-yogurt', listId: LIST_ID, name: 'Greek yogurt', storeIds: [TJ], prices: [{ amount: 6.49, storeId: TJ, details: 'tub' }] },
      { identifier: 'i-eggs', listId: LIST_ID, name: 'Eggs', storeIds: [TJ] },
      { identifier: 'i-bananas', listId: LIST_ID, name: 'Bananas', prices: [{ amount: 0.29 }] },
      { identifier: 'i-oats', listId: LIST_ID, name: 'Oats', storeIds: [TJ, ALDI], prices: [{ amount: 2.99, storeId: ALDI }] },
    ]);
  });

  it('reads the main price and lists store prices separately', async () => {
    const items = await ctx.client.getItems();
    const byName = Object.fromEntries(items.map(i => [i.name, [i.price, i.storePrices]]));
    assert.deepEqual(byName, {
      // A store's price is not the main price, even for an item assigned to that store.
      'Greek yogurt': [null, [{ store: 'Trader Joes', amount: 6.49 }]],
      'Eggs': [null, undefined],
      'Bananas': [0.29, undefined],
      'Oats': [null, [{ store: 'Aldi', amount: 2.99 }]],
    });
  });

  it('sets the main price by default, even for an item assigned to a store', async () => {
    await ctx.client.setItemPrice('Greek yogurt', 5.49);

    assert.equal(ctx.posts.length, 1);
    assert.equal(ctx.posts[0].url, 'data/shopping-lists/update');
    const op = decodeOperation(ctx.anylist, ctx.posts[0]);
    assert.equal(op.metadata.handlerId, 'save-item-price');
    assert.equal(op.metadata.userId, 'user-1');
    assert.equal(op.listId, LIST_ID);
    assert.equal(op.listItemId, 'i-yogurt');
    assert.equal(op.itemPrice.amount, 5.49);
    assert.equal(op.itemPrice.storeId, null);

    const yogurt = (await ctx.client.getItems()).find(i => i.name === 'Greek yogurt');
    assert.equal(yogurt.price, 5.49);
    assert.deepEqual(yogurt.storePrices, [{ store: 'Trader Joes', amount: 6.49 }]);
  });

  it('replaces a named store\'s price and keeps its details', async () => {
    await ctx.client.setItemPrice('Greek yogurt', 5.99, 'Trader Joes');
    const op = decodeOperation(ctx.anylist, ctx.posts[0]);
    assert.equal(op.itemPrice.storeId, TJ);
    assert.equal(op.itemPrice.amount, 5.99);
    assert.equal(op.itemPrice.details, 'tub');

    const yogurt = (await ctx.client.getItems()).find(i => i.name === 'Greek yogurt');
    assert.equal(yogurt.price, null);
    assert.deepEqual(yogurt.storePrices, [{ store: 'Trader Joes', amount: 5.99 }]);
  });

  it('rejects an unknown store without sending anything', async () => {
    await assert.rejects(() => ctx.client.setItemPrice('Eggs', 1, 'Costco'), /Store "Costco" not found/);
    assert.equal(ctx.posts.length, 0);
  });

  it('clears the main price with 0 by sending an empty no-store price', async () => {
    await ctx.client.setItemPrice('Bananas', 0);
    const op = decodeOperation(ctx.anylist, ctx.posts[0]);
    assert.equal(op.itemPrice.amount, null);
    assert.equal(op.itemPrice.storeId, null);
    assert.equal((await ctx.client.getItems()).find(i => i.name === 'Bananas').price, null);
  });

  it('clears one store\'s price and leaves the rest', async () => {
    await ctx.client.setItemPrice('Oats', 0, 'Aldi');
    const op = decodeOperation(ctx.anylist, ctx.posts[0]);
    assert.equal(op.itemPrice.amount, null);
    assert.equal(op.itemPrice.storeId, ALDI);
    const oats = (await ctx.client.getItems()).find(i => i.name === 'Oats');
    assert.equal(oats.price, null);
    assert.equal(oats.storePrices, undefined);
  });

  it('remembers prices of items added after the snapshot', async () => {
    const item = ctx.anylist.createItem({ name: 'Spicy Spuds' });
    await ctx.client.targetList.addItem(item);
    ctx.posts.length = 0;

    await ctx.client.setItemPrice('Spicy Spuds', 3.29);
    assert.equal((await ctx.client.getItems()).find(i => i.name === 'Spicy Spuds').price, 3.29);
  });
});
