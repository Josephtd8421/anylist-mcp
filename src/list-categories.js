// Per-list categories and category sets ("category groups" in AnyList's API).
//
// Every AnyList list (grocery, dinners, to-do, ...) has one or more category
// groups. With "Category Sets" turned off a list has exactly one group; with
// it on, each set is its own group. Items are placed into a category through
// `categoryAssignments` (one entry per group) plus a `categoryMatchId` slug.
//
// These helpers take the MCP's AnyListClient (already connected to a list)
// and work on `client.targetList`. They live in their own module so they stay
// independent of the shopping tool's item code.

import FormData from 'form-data';
import { randomUUID } from 'node:crypto';

const newId = () => randomUUID().replace(/-/g, '');

const norm = (s) => String(s || '').trim().toLowerCase();

export function slugify(name) {
  return norm(name).replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

/**
 * Re-fetch the account's lists so category data is current, then re-select
 * the connected list. Category changes made in the apps don't reach the
 * cached copy otherwise.
 */
export async function refreshTargetList(client) {
  if (!client.client || !client.targetList) {
    throw new Error('Not connected to any list. Call connect() first.');
  }
  const name = client.targetList.name;
  await client.client.getLists();
  const fresh = client.client.getListByName(name);
  if (!fresh) throw new Error(`List "${name}" not found after refresh`);
  client.targetList = fresh;
  return fresh;
}

/** Pick a category group (set) by name, or the list's first group. */
export function resolveGroup(list, setName = null) {
  const groups = list.categoryGroups || [];
  if (groups.length === 0) {
    throw new Error(`List "${list.name}" has no category groups.`);
  }
  if (!setName) return groups[0];
  const target = norm(setName);
  const group = groups.find(g => norm(g.name) === target);
  if (!group) {
    const names = groups.map(g => `"${g.name || '(unnamed)'}"`).join(', ');
    throw new Error(`Category set "${setName}" not found on list "${list.name}". Sets: ${names}`);
  }
  return group;
}

function findCategoryInGroup(group, name) {
  const target = norm(name);
  return (group.categories || []).find(c => norm(c.name) === target) || null;
}

/**
 * Describe a list's category sets and their categories, with item counts.
 * Read-only.
 */
/**
 * Which category of `group` an item shows under. An explicit assignment in
 * that set wins; otherwise AnyList places the item by its match id (the
 * built-in grocery categories carry it as `systemCategory`); anything left
 * falls into the set's default category.
 */
export function categoryIdForItem(item, group) {
  const assigned = (item.categoryAssignments || []).find(a => a.categoryGroupId === group.identifier);
  if (assigned && (group.categories || []).some(c => c.identifier === assigned.categoryId)) {
    return assigned.categoryId;
  }
  const matchId = item.categoryMatchId;
  if (matchId && matchId !== 'other') {
    const byMatch = (group.categories || []).find(c => c.systemCategory === matchId)
      || (group.categories || []).find(c => !c.systemCategory && slugify(c.name) === matchId);
    if (byMatch) return byMatch.identifier;
  }
  return group.defaultCategoryId || null;
}

export function describeCategories(list) {
  const items = (list.items || []).filter(i => !i.checked);
  return (list.categoryGroups || []).map(group => {
    const counts = {};
    for (const item of items) {
      const id = categoryIdForItem(item, group);
      if (id) counts[id] = (counts[id] || 0) + 1;
    }
    const categories = [...(group.categories || [])]
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
      .map(c => {
        const itemCount = counts[c.identifier] || 0;
        return {
          name: c.name,
          id: c.identifier,
          systemCategory: c.systemCategory || null,
          isDefault: c.identifier === group.defaultCategoryId,
          itemCount,
        };
      });
    return { name: group.name || null, id: group.identifier, categories };
  });
}

export async function listCategories(client) {
  const list = await refreshTargetList(client);
  return { listName: list.name, sets: describeCategories(list) };
}

/**
 * Create a category on the connected list. If a category with the same name
 * already exists in that set, nothing is written and `created` is false.
 */
export async function createCategory(client, name, setName = null) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Category name is required.');
  const list = await refreshTargetList(client);
  const group = resolveGroup(list, setName);
  const existing = findCategoryInGroup(group, clean);
  if (existing) {
    return { created: false, category: existing, setName: group.name || null, listName: list.name };
  }
  const maxSort = Math.max(-1, ...(group.categories || []).map(c => c.sortIndex ?? 0));
  const category = await list.createCategory({
    name: clean,
    categoryGroupId: group.identifier,
    sortIndex: maxSort + 1,
  });
  return { created: true, category, setName: group.name || null, listName: list.name };
}

function findRawItem(anylist, listId, itemId) {
  const lists = anylist._userData?.shoppingListsResponse?.newLists || [];
  const rawList = lists.find(l => l.identifier === listId);
  return (rawList?.items || []).find(i => i.identifier === itemId) || null;
}

/**
 * Put an item into a category on the connected list.
 *
 * The update re-sends the item exactly as AnyList returned it (prices, notes,
 * photos, recipe links and other category sets' assignments are kept); only
 * the assignment for the chosen set and the match id change.
 */
export async function setItemCategory(client, itemName, categoryName, setName = null) {
  const list = await refreshTargetList(client);
  const item = list.getItemByName(itemName)
    || (list.items || []).find(i => norm(i.name) === norm(itemName));
  if (!item) throw new Error(`Item "${itemName}" not found in list "${list.name}"`);
  const group = resolveGroup(list, setName);
  const category = findCategoryInGroup(group, categoryName);
  if (!category) {
    const names = (group.categories || []).map(c => `"${c.name}"`).join(', ');
    throw new Error(`Category "${categoryName}" not found${group.name ? ` in set "${group.name}"` : ''} on list "${list.name}". Categories: ${names}. Create it first with create_category.`);
  }

  const anylist = client.client;
  const raw = findRawItem(anylist, list.identifier, item.identifier);
  if (!raw) throw new Error(`Could not load the full record for "${item.name}"; nothing was changed.`);

  const proto = anylist.protobuf;
  // Work on a copy so a failed request doesn't leave the cache half-changed.
  const updated = proto.ListItem.decode(raw.toBuffer());

  // Match id: the category's system slug, else one a sibling item already
  // uses for this category, else a slug of the name.
  let matchId = category.systemCategory || null;
  if (!matchId) {
    const sibling = (list.items || []).find(i => i.identifier !== item.identifier && (i.categoryAssignments || [])
      .some(a => a.categoryGroupId === group.identifier && a.categoryId === category.identifier));
    matchId = sibling?.categoryMatchId && sibling.categoryMatchId !== 'other' ? sibling.categoryMatchId : slugify(category.name);
  }

  const kept = (updated.categoryAssignments || []).filter(a => a.categoryGroupId !== group.identifier);
  updated.categoryAssignments = [
    ...kept,
    new proto.PBListItemCategoryAssignment({
      identifier: newId(),
      categoryGroupId: group.identifier,
      categoryId: category.identifier,
    }),
  ];
  updated.categoryMatchId = matchId;

  const op = new proto.PBListOperation();
  op.setMetadata({ operationId: newId(), handlerId: 'update-list-item', userId: anylist.uid });
  op.setListId(list.identifier);
  op.setListItemId(item.identifier);
  op.setListItem(updated);

  const opList = new proto.PBListOperationList();
  opList.setOperations([op]);
  const form = new FormData();
  form.append('operations', opList.toBuffer());
  await anylist.client.post('data/shopping-lists/update', { body: form });

  return { itemName: item.name, categoryName: category.name, setName: group.name || null, listName: list.name };
}
