import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { register } from '../../src/tools/categories.js';
import { slugify } from '../../src/list-categories.js';
import { createMockServer } from './helpers.js';

const require = createRequire(import.meta.url);
const protobufLib = require('protobufjs');
const definitions = require('../../anylist-js/lib/definitions.json');
const List = require('../../anylist-js/lib/list.js');

const proto = protobufLib.newBuilder({}).import(definitions).build('pcov.proto');

const LIST_ID = 'list1';
const GROUP_A = 'groupA';
const GROUP_B = 'groupB';

function buildAccount({ withSecondSet = false } = {}) {
  const rawList = proto.ShoppingList.decode(new proto.ShoppingList({
    identifier: LIST_ID,
    name: 'Weekly Dinners',
    items: [
      {
        identifier: 'i1', listId: LIST_ID, name: 'Tacos', details: 'Tuesday',
        categoryMatchId: 'other',
        categoryAssignments: withSecondSet
          ? [{ identifier: 'a0', categoryGroupId: GROUP_B, categoryId: 'b-other' }]
          : [],
        prices: [{ amount: 4.5 }],
      },
      {
        identifier: 'i2', listId: LIST_ID, name: 'Chili', categoryMatchId: 'other',
        categoryAssignments: [{ identifier: 'a1', categoryGroupId: GROUP_A, categoryId: 'a-other' }],
      },
    ],
  }).toBuffer());

  const groups = [{
    categoryGroup: {
      identifier: GROUP_A, name: 'Default', listId: LIST_ID, defaultCategoryId: 'a-other',
      categories: [{ identifier: 'a-other', name: 'Other', categoryGroupId: GROUP_A, sortIndex: 0 }],
    },
  }];
  if (withSecondSet) {
    groups.push({
      categoryGroup: {
        identifier: GROUP_B, name: 'By Day', listId: LIST_ID, defaultCategoryId: 'b-other',
        categories: [{ identifier: 'b-other', name: 'Other', categoryGroupId: GROUP_B, sortIndex: 0 }],
      },
    });
  }

  const posts = [];
  const anylist = {
    uid: 'user1',
    protobuf: proto,
    _userData: { shoppingListsResponse: { newLists: [rawList] } },
    lists: [],
    client: { post: async (url, opts) => { posts.push({ url, body: opts.body }); return {}; } },
    async getLists() {
      this.lists = this._userData.shoppingListsResponse.newLists.map(l => {
        const list = new List(l, { client: this.client, protobuf: proto, uid: this.uid });
        list._setCategoryGroups(groups);
        return list;
      });
      return this.lists;
    },
    getListByName(name) { return this.lists.find(l => l.name === name); },
  };

  const client = {
    client: anylist,
    targetList: null,
    async connect(name) {
      if (!anylist.lists.length) await anylist.getLists();
      this.targetList = anylist.getListByName(name || 'Weekly Dinners');
      if (!this.targetList) throw new Error(`List "${name}" not found`);
      return true;
    },
  };
  return { client, posts, groups };
}

function decodeOps(post) {
  // form-data body: pull the protobuf bytes back out of the multipart payload.
  const buf = post.body.getBuffer();
  const start = buf.indexOf('\r\n\r\n') + 4;
  const end = buf.lastIndexOf('\r\n--');
  return proto.PBListOperationList.decode(buf.slice(start, end)).operations;
}

describe('categories tool', () => {
  let handlers;
  let account;

  function setup(opts) {
    account = buildAccount(opts);
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(account.client));
    handlers = h;
  }

  beforeEach(() => setup());

  describe('list_categories', () => {
    it('lists categories with item counts and makes no requests', async () => {
      const result = await handlers.categories({ action: 'list_categories', list_name: 'Weekly Dinners' });
      const text = result.content[0].text;
      assert.ok(text.includes('Categories on list "Weekly Dinners"'), text);
      assert.ok(text.includes('- Other (default) (1 item)'), text);
      assert.equal(account.posts.length, 0);
    });

    it('shows every set when the list has several', async () => {
      setup({ withSecondSet: true });
      const result = await handlers.categories({ action: 'list_categories', list_name: 'Weekly Dinners' });
      const text = result.content[0].text;
      assert.ok(text.includes('2 category sets'), text);
      assert.ok(text.includes('**Set: By Day**'), text);
    });

    it('reports an unknown list as an error', async () => {
      const result = await handlers.categories({ action: 'list_categories', list_name: 'Nope' });
      assert.equal(result.isError, true);
    });
  });

  describe('create_category', () => {
    it('sends one create-category op to the v2 endpoint', async () => {
      const result = await handlers.categories({ action: 'create_category', list_name: 'Weekly Dinners', category_name: 'Monday' });
      assert.ok(result.content[0].text.includes('Created category "Monday"'), result.content[0].text);
      assert.equal(account.posts.length, 1);
      assert.equal(account.posts[0].url, 'data/shopping-lists/update-v2');
      const [op] = decodeOps(account.posts[0]);
      assert.equal(op.metadata.handlerId, 'create-category');
      assert.equal(op.listId, LIST_ID);
      assert.equal(op.updatedCategory.name, 'Monday');
      assert.equal(op.updatedCategory.categoryGroupId, GROUP_A);
      assert.equal(op.updatedCategory.sortIndex, 1);
    });

    it('does nothing when the category already exists', async () => {
      const result = await handlers.categories({ action: 'create_category', list_name: 'Weekly Dinners', category_name: ' other ' });
      assert.ok(result.content[0].text.includes('already exists'), result.content[0].text);
      assert.equal(account.posts.length, 0);
    });

    it('targets the named set', async () => {
      setup({ withSecondSet: true });
      await handlers.categories({ action: 'create_category', list_name: 'Weekly Dinners', category_name: 'Friday', set_name: 'by day' });
      const [op] = decodeOps(account.posts[0]);
      assert.equal(op.updatedCategory.categoryGroupId, GROUP_B);
    });

    it('errors on an unknown set without writing', async () => {
      const result = await handlers.categories({ action: 'create_category', list_name: 'Weekly Dinners', category_name: 'X', set_name: 'Nope' });
      assert.equal(result.isError, true);
      assert.equal(account.posts.length, 0);
    });

    it('requires category_name', async () => {
      const result = await handlers.categories({ action: 'create_category', list_name: 'Weekly Dinners' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('category_name'));
    });
  });

  describe('set_item_category', () => {
    function addCategory(groupIdx, cat) {
      account.groups[groupIdx].categoryGroup.categories.push(cat);
    }

    it('moves the item and keeps its other fields', async () => {
      addCategory(0, { identifier: 'a-mon', name: 'Monday', categoryGroupId: GROUP_A, sortIndex: 1 });
      const result = await handlers.categories({ action: 'set_item_category', list_name: 'Weekly Dinners', item_name: 'tacos', category_name: 'Monday' });
      assert.ok(result.content[0].text.includes('Moved "Tacos" to category "Monday"'), result.content[0].text);
      assert.equal(account.posts.length, 1);
      assert.equal(account.posts[0].url, 'data/shopping-lists/update');
      const [op] = decodeOps(account.posts[0]);
      assert.equal(op.metadata.handlerId, 'update-list-item');
      assert.equal(op.listItemId, 'i1');
      assert.equal(op.listItem.details, 'Tuesday');
      assert.equal(op.listItem.prices.length, 1);
      assert.equal(op.listItem.prices[0].amount, 4.5);
      assert.equal(op.listItem.categoryMatchId, 'monday');
      assert.deepEqual(op.listItem.categoryAssignments.map(a => [a.categoryGroupId, a.categoryId]), [[GROUP_A, 'a-mon']]);
    });

    it('keeps the assignment in other sets', async () => {
      setup({ withSecondSet: true });
      addCategory(0, { identifier: 'a-mon', name: 'Monday', categoryGroupId: GROUP_A, sortIndex: 1 });
      await handlers.categories({ action: 'set_item_category', list_name: 'Weekly Dinners', item_name: 'Tacos', category_name: 'Monday' });
      const [op] = decodeOps(account.posts[0]);
      const pairs = op.listItem.categoryAssignments.map(a => [a.categoryGroupId, a.categoryId]);
      assert.deepEqual(pairs, [[GROUP_B, 'b-other'], [GROUP_A, 'a-mon']]);
    });

    it('does not change the cached item when it builds the update', async () => {
      addCategory(0, { identifier: 'a-mon', name: 'Monday', categoryGroupId: GROUP_A, sortIndex: 1 });
      await handlers.categories({ action: 'set_item_category', list_name: 'Weekly Dinners', item_name: 'Tacos', category_name: 'Monday' });
      const raw = account.client.client._userData.shoppingListsResponse.newLists[0].items[0];
      assert.equal(raw.categoryAssignments.length, 0);
    });

    it('errors on an unknown category without writing', async () => {
      const result = await handlers.categories({ action: 'set_item_category', list_name: 'Weekly Dinners', item_name: 'Tacos', category_name: 'Monday' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('create_category'));
      assert.equal(account.posts.length, 0);
    });

    it('errors on an unknown item without writing', async () => {
      const result = await handlers.categories({ action: 'set_item_category', list_name: 'Weekly Dinners', item_name: 'Pizza', category_name: 'Other' });
      assert.equal(result.isError, true);
      assert.equal(account.posts.length, 0);
    });
  });

  it('slugify makes AnyList-style match ids', () => {
    assert.equal(slugify('Snacks & Treats'), 'snacks-and-treats');
    assert.equal(slugify('  '), 'other');
  });
});
