---
name: ux-declutter
description: Review a screen for visual noise and redesign it to be calm — fewer elements, one accent, progressive disclosure, the main action first. Use whenever you build or change UI on web, desktop or mobile, before calling it done, and whenever you look at a screenshot of your own UI.
---

# Declutter a screen

A screen that works can still be poor. The usual failure is noise: every capability
visible at once, the same fact said twice, several colors fighting for attention,
and edit controls where someone only wanted to read. Do this pass on every UI change,
from a real screenshot, not from the code.

## 1. Look at it

Capture the screen in its common state (web E2E screenshot, simulator, emulator).
Code review does not show noise; a screenshot does. Look at it as someone who opened
it to do one thing.

## 2. Inventory every element

List every visible word, control, color and container, top to bottom. For each
ask, in this order:

1. **Remove?** Does it earn its place on this screen, for most visits? Explainer copy
   that restates a label, a heading that repeats the values under it, a field that
   repeats the title, a status that is obvious — delete.
2. **Merge?** Is the same fact shown twice (title and a name field, a group label and
   its rows, a summary and the controls that set it)? Keep one.
3. **Disclose later?** Is it needed only sometimes? Move it behind a tap:
   - Read first, edit second. Open a record as a calm summary; put the form behind
     **Edit**. Inputs everywhere tell people they must fill something in.
   - A long list (history, runs, logs) becomes one row with a chevron to its own screen.
   - Rare or destructive actions (delete, export, test, remove one item) go in a menu,
     the edit screen, a swipe, or the bottom of the edit form — not repeated per item.
4. **Shrink?** Could an icon replace a word (add, share, play, more) where the meaning
   is universal? Give it an accessible label. Could a value sit at the end of its row
   instead of taking its own row?

## 3. Order by use

The control people touch most goes first (an on/off switch, the main content).
Then the content they came to read. Then secondary facts (schedule, next run).
Navigation rows (history, settings) and the way into editing go last.

## 4. Color

One accent at a time. Text is ink and secondary gray. Use the accent for the single
primary action or link. Destructive red appears once, where deleting happens, not on
every row. A switch's own color is enough; do not add colored buttons around it.
Count the distinct colors in the screenshot: more than ink, gray, one accent and
(rarely) one red is noise.

## 5. Consistency of controls

One kind of button per job. Do not mix floating pills, full-width filled buttons,
tinted text rows and header buttons on one screen. On mobile, prefer the platform's
places: header buttons for Save/Cancel/Edit and icons, list rows for navigation,
native menus for choices, swipe or a menu for per-item actions.

## 6. Redo the screenshot and compare

Capture again and put old and new side by side. Count elements and colors before and
after. If a reference design or a sibling screen exists, match its density and
structure. Keep going until nothing more can be removed without losing what the
screen is for.

## Signs you are not done

- Every field on a view screen is editable.
- The header title also appears in the body.
- A group label says what its rows already say.
- Each item in a list carries its own Remove/Delete text button.
- More than one filled or colored button is visible.
- A history or log list is expanded inline on a detail screen.
- Copy explains what a control does when its label already says it.
