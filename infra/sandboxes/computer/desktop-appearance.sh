#!/bin/sh
set -eu
# Keep desktop defaults outside the persistent user home and apply per X display.
printf 'Xcursor.theme: Cadre\nXcursor.size: 24\n' | xrdb -merge
feh --no-fehbg --bg-fill /usr/share/cadre/wallpaper.png
xsetroot -xcf /usr/share/icons/Cadre/cursors/left_ptr 24
