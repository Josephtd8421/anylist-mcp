import { z } from "zod";
import { textResponse, errorResponse, requireParams } from "./helpers.js";
import { listCategories, createCategory, setItemCategory } from "../list-categories.js";

const DESCRIPTION = `See and manage the categories on any AnyList list (grocery, dinners, to-do and other list types), not only the built-in grocery categories. Actions:
- list_categories: Show a list's category sets and the categories in each, with item counts (read-only)
- create_category: Add a new category to a list (in its first category set, or the one named by set_name). Does nothing if a category with that name already exists there
- set_item_category: Move an existing item into one of the list's categories (create the category first if needed)`;

export function register(server, getClient) {
  server.registerTool("categories", {
    title: "List Categories",
    description: DESCRIPTION,
    inputSchema: {
      action: z.enum(["list_categories", "create_category", "set_item_category"]).describe("The category action to perform"),
      list_name: z.string().optional().describe("Name of the list (defaults to configured default list)"),
      category_name: z.string().optional().describe("Category name (required for create_category and set_item_category)"),
      item_name: z.string().optional().describe("Item name (required for set_item_category)"),
      set_name: z.string().optional().describe("Category set to use when the list has more than one (defaults to the list's first set)"),
    },
  }, async (params) => {
    const { action, list_name, category_name, item_name, set_name } = params;
    try {
      const client = await getClient();
      await client.connect(list_name || null);
      switch (action) {
        case "list_categories": {
          const { listName, sets } = await listCategories(client);
          if (sets.length === 0) return textResponse(`List "${listName}" has no categories.`);
          const multi = sets.length > 1;
          const blocks = sets.map(set => {
            const header = multi ? `**Set: ${set.name || "(unnamed)"}**\n` : "";
            const lines = set.categories.length === 0
              ? "  (no categories)"
              : set.categories.map(c => `- ${c.name}${c.isDefault ? " (default)" : ""} (${c.itemCount} item${c.itemCount === 1 ? "" : "s"})`).join("\n");
            return header + lines;
          });
          const intro = multi
            ? `List "${listName}" has ${sets.length} category sets:`
            : `Categories on list "${listName}":`;
          return textResponse(`${intro}\n${blocks.join("\n\n")}`);
        }
        case "create_category": {
          requireParams(params, ["category_name"], action);
          const result = await createCategory(client, category_name, set_name || null);
          const where = result.setName ? ` (set "${result.setName}")` : "";
          return textResponse(result.created
            ? `Created category "${result.category.name}" on list "${result.listName}"${where}.`
            : `Category "${result.category.name}" already exists on list "${result.listName}"${where}; nothing changed.`);
        }
        case "set_item_category": {
          requireParams(params, ["item_name", "category_name"], action);
          const result = await setItemCategory(client, item_name, category_name, set_name || null);
          const where = result.setName ? ` (set "${result.setName}")` : "";
          return textResponse(`Moved "${result.itemName}" to category "${result.categoryName}" on list "${result.listName}"${where}.`);
        }
      }
    } catch (error) {
      return errorResponse(`Categories ${action} failed: ${error.message}`);
    }
  });
}
