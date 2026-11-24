# Typebot Exporter for Miro: setup guide

The app is 5 files: `index.html`, `app.html`, `app.js`, `converter.js`, `save.html`. Keep them together in one folder.

## Part 1: put the files online (GitHub + Vercel)

1. Go to github.com and sign in.
2. Click the **+** at the top right, then **New repository**.
3. Name it `miro-typebot-exporter`, leave it **Public**, click **Create repository**.
4. On the next page, click the link **uploading an existing file**.
5. Drag the 5 files into the page, then click **Commit changes**.
6. Go to vercel.com and sign in (use **Continue with GitHub**).
7. Click **Add New…**, then **Project**.
8. Next to `miro-typebot-exporter`, click **Import**, then **Deploy**. Leave every setting as it is.
9. When you see "Congratulations", click **Continue to Dashboard** and copy the address under **Domains** (it looks like `https://miro-typebot-exporter.vercel.app`).

## Part 2: create the Miro app

1. In Miro, click your profile picture (top right), then **Settings**.
2. Open the **Your apps** tab, then click **Create new app**.
3. Name it `Typebot Exporter`, choose your team, click **Create app**.
4. In **App URL**, paste the Vercel address from Part 1, step 9. Click **Save**.
5. Under **Permissions**, tick **boards:read**.
6. Click **Install app and get OAuth token**, choose your team, click **Add**.

## Part 3: use it

1. Open a board. In the left toolbar click **>>** (More apps) and pick **Typebot Exporter**.
2. Choose the package (15, 30, 75 or 100).
3. Choose the frame, or select the frame on the board and click **Use selected**.
4. Click **Test flow**.
   - Red cards must be fixed. Green buttons fix it for you; **Show on board** takes you to the box so you can fix it yourself, then click **Re-test**.
   - **Please check** lists guesses the app made (for example "Customer reply added").
   - **Fixed automatically** lists technical fixes already done.
5. Click **Save file…**. A new tab opens; click **Choose where to save** and pick the folder.
6. In Typebot: **Create a typebot** → **Import a file** → choose the saved file.

## How to draw the flow so it converts well

- One box = one message. Arrows show the order.
- Buttons: arrows from the question box to short boxes (the button text), each with one arrow to the next step. Or write the button text as a label on the arrow.
- Team assignment: a diamond with the team email inside, e.g. `تعيين لقسم الدعم support@company.com`.
- End: a box with `إنهاء المحادثة`. Back to menu: a box with `القائمة الرئيسية`.
- Customer reply: a message asking to describe/attach something, or a box with `إدخال نص`.
- Wait: a box with `انتظار 3` (seconds).
- New / returning customer: two arrows labelled `عميل جديد` and `عميل قديم`.
- Sticky notes are notes for the team and are never exported.

## Updating the app later

Upload the changed file to the same GitHub repository (**Add file → Upload files → Commit changes**). Vercel updates the app by itself within a minute.
