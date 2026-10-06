# Flight 14-CA

A cinematic scroll website and Pomodoro timer for Golden State Airlines. Every 60 minutes of focus, the clouds part outside your window and the flight attendant introduces the next of 30 California stops.

## Run it

```bash
npm install          # installs ffmpeg-static (used only by the frame tool)
npm run frames       # downloads the Higgsfield stills + films and slices them into scroll frames
npm run voices       # records the 30 narrations with Gemini TTS (needs GEMINI_API_KEY, see below)
npm start            # opens the site at http://localhost:8014
```

The zip ships with **stand-in frames** so the site works immediately. `npm run frames` replaces them with the real Higgsfield footage: the hero plate plus one window view for each of the 30 stops, and the two films sliced into about 200 frames each at 1920 px (WebP). The orange stand-in notice then disappears. Needs Node 18 or newer.

Already downloaded the files yourself? Put them in one folder named after the keys in `tools/higgsfield-assets.json` (`hero.png`, `yosemite.png` … `venice.png`, `flight.mp4`, `unlock.mp4`) and run `npm run frames -- --source path/to/folder`. Any still that is missing falls back to the hero view.

Other options: `--frames 240`, `--width 2560`, `--format jpg`, `--quality 85`.

## Record the flight attendant's voice (Gemini TTS)

The Listen buttons play a recorded narration for each stop, made with Gemini TTS from the same text as the site (model and voices are in `tools/voices.json`: Veda for odd-numbered stops, Achird for even ones).

```bash
export GEMINI_API_KEY="paste-your-key-here"   # from aistudio.google.com, "Get API key"
npm run voices
```

This creates `assets/audio/narration/01-yosemite.mp3` … `30-venice-beach.mp3` (about 0.5 MB each). If Google rate-limits you, the tool waits and retries; if it stops, run it again and it continues where it left off. `npm run voices -- --only 7` re-records just stop 7, and `--force` re-records everything. Until a stop has a recording, its Listen button uses the browser's built-in voice. The key is only read from the Terminal session and is never saved into the project.

## Chapters

1. **The Flight**: scrolling scrubs the looping flight film. The timer lives on the right cabin wall: Focus / Break / Long break, start, restart, skip, session count, tasks. While the timer runs, the plane keeps cruising on its own.
2. **The Unlock**: the meter counts up to your unlocked stops as the chapter arrives. When a focus session completes, the flight attendant chime plays and the page scrubs through the clouds parting, then settles on that stop's own window view, with its narration (optionally read aloud).
3. **Window seat**: a camera roll of your latest 10 unlocked views, plus a glimpse of the next stop.
4. **The whole itinerary**: all 30 postcards; unlocked ones open the window view and the attendant's full story.

The **Music** and **Chime** toggles are in the top bar. The soundtrack (`assets/audio/soundtrack.mp3`) starts with your first click or key press, loops, and dips under the chime and narration; replace that file to change the music, or delete it and the Music button disappears.

The chapter dots on the right edge jump between chapters, and the unlock reveal can be skipped with Skip or Esc. Timer lengths, auto-start, chime volume and repeats, and narration are under Settings. Space starts and pauses the timer.

## Why the timer stays accurate

- The clock is derived from the session's end time (`Date.now()`), never counted down tick by tick.
- Ticks come from a Web Worker plus a one-shot wake-up aimed at the exact end, so scrolling, canvas drawing and background tabs don't slow it.
- The chime is queued on the Web Audio clock when the session starts, so it rings on time even if the page is busy or minimized.
- Progress (hours, unlocked stops, tasks, settings) is saved in the browser; Export/Import in the footer moves it between devices.

## Publish on GitHub Pages (Mac, with GitHub Desktop)

1. **Load the real footage and voices first:** `npm install`, `npm run frames`, `npm run voices`, `npm start`, check the site, then Control + C.
2. **Optional, the soundtrack:** a public repository lets anyone download every file, including the MP3. To keep the music on your computer only, run `echo "assets/audio/soundtrack.mp3" >> .gitignore` inside the folder before step 4. Online, the Music button then simply hides.
3. Install **GitHub Desktop** from desktop.github.com and sign in.
4. **File → Add Local Repository…** → choose the `flight-14-ca` folder → click **create a repository** → name `flight-14-ca`, leave README unticked and Git Ignore as None → **Create Repository**.
5. Click **Publish repository**, untick **Keep this code private** (free GitHub Pages needs a public repository) → **Publish Repository**.
6. On github.com open the repository → **Settings → Pages** → Source **Deploy from a branch**, branch **main**, folder **/ (root)** → **Save**. After a minute or two the site is live at `https://<your-username>.github.io/flight-14-ca/`.
7. **Updating later:** change files, then in GitHub Desktop write a short summary → **Commit to main** → **Push origin**.

`node_modules/` and `tools/.cache/` are listed in `.gitignore`, so they are never uploaded. Progress is saved per website: use **Export progress** on localhost and **Import** on the live site to carry it over.

## Credits

Stills: GPT Image 2.5. Films: Kling 3.0. Both generated on Higgsfield; job ids and source URLs are in `tools/higgsfield-assets.json`. Soundtrack: supplied by the site owner. Smooth scrolling: [Lenis](https://github.com/darkroomengineering/lenis) (MIT). Narration text: the Flight 14-CA script.
