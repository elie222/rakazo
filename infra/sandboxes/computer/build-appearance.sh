#!/bin/sh
set -eu
assets=/usr/share/cadre
cursors=/usr/share/icons/Cadre/cursors
mkdir -p "$cursors"
convert -background none "$assets/wallpaper.svg" "$assets/wallpaper.png"
for size in 24 32 48 64; do
  convert -background none "$assets/cursor.svg" -resize "${size}x${size}" "/tmp/cadre-cursor-$size.png"
  printf '%s %s %s %s\n' "$size" "$((3 * size / 32))" "$((2 * size / 32))" "/tmp/cadre-cursor-$size.png"
done > /tmp/cadre-cursor.conf
xcursorgen /tmp/cadre-cursor.conf "$cursors/left_ptr"
for name in default arrow top_left_arrow; do
  ln -sf left_ptr "$cursors/$name"
done
printf '[Icon Theme]\nName=Cadre\nInherits=Adwaita\n' > /usr/share/icons/Cadre/index.theme
rm /tmp/cadre-cursor-*.png /tmp/cadre-cursor.conf
