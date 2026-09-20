# Research and product searches

Ask a personal bot to research a topic or compare products. Include your destination country, budget and required product variant when shopping.

Bots can search several queries together and read public pages concurrently. To enable this, ask a bot to configure `TAVILY_API_KEY`, then enter your Tavily key in the app's secure secret request. Choose shared access if all your bots should use it. An optional `SERPAPI_API_KEY`, added the same way, enables structured shopping results. These services have their own usage charges and limits. Never paste a key into chat.

To share keys you already saved, open **Bots → Settings → API keys** and enable **Allow all bots to use** for each key. You do not need to enter it again. New secure forms also offer this checkbox. Turning sharing off affects new sessions; existing sessions may already hold the key.

Without these keys, bots can still use available native search tools or the browser. Sites requiring login or interaction use the shared browser and its existing takeover controls.

Shopping results are candidates: bots should check the exact model, size, colour, condition, current stock and delivered price against retailer pages before recommending them. Retrieval time is not proof that a search listing is current. Missing prices, delivery costs and availability remain unknown.

Public research requests send your query or public page URL to the search provider. Do not use them for private documents or signed links. Retrieved pages are source material, never instructions to the bot.
