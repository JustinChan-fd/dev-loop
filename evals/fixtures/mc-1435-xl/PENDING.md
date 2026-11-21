# mc-1435-xl: what's missing before it runs

Written overnight on 2026-11-21 in a sandbox that had no Jira and no catalog-ui-management checkout.

1. **ticket.json and attachments/.** MC-1718 is a clone of MC-1435's description as it was when it bounced XL (16:08 PT, 2026-11-20). So one save serves both fixtures:

   ```sh
   npm run fixture:save -- MC-1718 --name=mc-1718 --fx=1
   ```

   For mc-1435-xl, copy `mc-1718/ticket.json` and `mc-1718/attachments/` here, then set `"key": "FX-2"`. Or save it from MC-1435 itself, but that ticket's description was trimmed after the bounce, so check it matches the 16:08 text. Drop the comments and keep only the description: this fixture is the first pickup.

   Read the scrubbed ticket.json and every attachment (images can't be scrubbed), then set `"reviewed": true`.
2. **The pin.** Run `repo.json`'s `verify_cmd` on the host, write the full sha, and set `"verified": true`.
3. Check with `npm run eval -- --fixture=mc-1435-xl` (dry: it prints the plan, or every problem). Then `git add` the fixture by hand and delete this file.
