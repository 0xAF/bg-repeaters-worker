#!/bin/bash

#rm -f reps.json
#wget https://varna.radio/reps.json

sqlite3 reps.db < schema.sql
./convert_reps_json.pl
sqlite3 -batch reps.db ".dump" | grep '^INSERT INTO' | sed -E 's/unistr\(([^)]*)\)/\1/g' > dump.sql

npx wrangler d1 execute RepsDB --local --file ./schema.sql
npx wrangler d1 execute RepsDB --local --file ./dump.sql

npx wrangler d1 execute RepsDB --remote --file ./schema.sql
npx wrangler d1 execute RepsDB --remote --file ./dump.sql

rm -f reps.db
