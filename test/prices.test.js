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

  it('reads the price AnyList shows for each item', async () => {
    const items = await ctx.client.getItems();
    const byName = Object.fromEntries(items.map(i => [i.name, i.price]));
    assert.deepEqual(byName, {
      'Greek yogurt': 6.49, // its one store's price
      'Eggs': null,         // no price yet
      'Bananas': 0.29,      // no store, so the no-store price
      'Oats': 2.99,         // the one assigned store that has a price
    });
  });

  it('sends a save-item-price op for the item\'s store and keeps its details', async () => {
    await ctx.client.setItemPrice('Greek yogurt', 5.49);

    assert.equal(ctx.posts.length, 1);
    assert.equal(ctx.posts[0].url, 'data/shopping-lists/update');
    const op = decodeOperation(ctx.anylist, ctx.posts[0]);
    assert.equal(op.metadata.handlerId, 'save-item-price');
    assert.equal(op.metadata.userId, 'user-1');
    assert.equal(op.listId, LIST_ID);
    assert.equal(op.listItemId, 'i-yogurt');
    assert.equal(op.itemPrice.amount, 5.49);
    assert.equal(op.itemPrice.storeId, TJ);
    assert.equal(op.itemPrice.details, 'tub');

    const yogurt = (await ctx.client.getItems()).find(i => i.name === 'Greek yogurt');
    assert.equal(yogurt.price, 5.49);
  });

  it('adds a first price under the item\'s only store', async () => {
    await ctx.client.setItemPrice('Eggs', 3.79);
    const op = decodeOperation(ctx.anylist, ctx.posts[0]);
    assert.equal(op.itemPrice.storeId, TJ);
    assert.equal((await ctx.client.getItems()).find(i => i.name === 'Eggs').price, 3.79);
  });

  it('saves the price for a named store', async () => {
    await ctx.client.setItemPrice('Eggs', 4.19, 'Aldi');
    const op = decodeOperation(ctx.anylist, ctx.posts[0]);
    assert.equal(op.itemPrice.storeId, ALDI);
  });

  it('rejects an unknown store without sending anything', async () => {
    await assert.rejects(() => ctx.client.setItemPrice('Eggs', 1, 'Costco'), /Store "Costco" not found/);
    assert.equal(ctx.posts.length, 0);
  });

  it('clears a price with 0 by sending an empty price for that store', async () => {
    await ctx.client.setItemPrice('Bananas', 0);
    const op = decodeOperation(ctx.anylist, ctx.posts[0]);
    assert.equal(op.itemPrice.amount, null);
    assert.equal(op.itemPrice.storeId, null);
    assert.equal((await ctx.client.getItems()).find(i => i.name === 'Bananas').price, null);
  });

  it('remembers prices of items added after the snapshot', async () => {
    const item = ctx.anylist.createItem({ name: 'Spicy Spuds' });
    await ctx.client.targetList.addItem(item);
    ctx.posts.length = 0;

    await ctx.client.setItemPrice('Spicy Spuds', 3.29);
    assert.equal((await ctx.client.getItems()).find(i => i.name === 'Spicy Spuds').price, 3.29);
  });
});
