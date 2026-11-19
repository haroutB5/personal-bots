// hbots-managed. Reapplied at every Thunderbird start. See dev-team/qa/hbots-email/WALKTHROUGH.md
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.update.enabled", false);
user_pref("extensions.update.autoUpdateDefault", false);
user_pref("extensions.commonpost-mcp.blockSkipReview", true);
user_pref("extensions.commonpost-mcp.blockCalendarSkipReview", true);
user_pref("extensions.commonpost-mcp.blockFilterForwardReply", true);
user_pref("extensions.commonpost-mcp.listenAll", false);
user_pref("extensions.commonpost-mcp.allowEncryptedContent", false);
user_pref(
  "extensions.commonpost-mcp.disabledTools",
  '["sendMail", "listCalendars", "createEvent", "listEvents", "updateEvent", "deleteEvent", "createTask", "listCategories", "listTasks", "updateTask", "deleteTask", "listAddressBooks", "searchContacts", "getContact", "createContact", "updateContact", "deleteContact", "forwardMessage", "displayMessage", "deleteMessages", "updateMessage", "createFolder", "renameFolder", "deleteFolder", "emptyTrash", "emptyJunk", "moveFolder", "listFilters", "createFilter", "updateFilter", "deleteFilter", "reorderFilters", "applyFilters"]',
);
user_pref(
  "extensions.commonpost-mcp.knownTools",
  '["listAccounts", "listFolders", "searchMessages", "getMessage", "getMessages", "sendMail", "saveDraft", "listCalendars", "createEvent", "listEvents", "updateEvent", "deleteEvent", "createTask", "listCategories", "listTasks", "updateTask", "deleteTask", "listAddressBooks", "searchContacts", "getContact", "createContact", "updateContact", "deleteContact", "replyToMessage", "forwardMessage", "getRecentMessages", "displayMessage", "deleteMessages", "updateMessage", "createFolder", "renameFolder", "deleteFolder", "emptyTrash", "emptyJunk", "moveFolder", "listFilters", "createFilter", "updateFilter", "deleteFilter", "reorderFilters", "applyFilters", "getAccountAccess"]',
);
user_pref("mailnews.database.global.indexer.enabled", true);
