#!/bin/bash

rm -f reps.json
wget https://varna.radio/reps.json

sqlite3 reps.db < schema.sql
./convert_reps_json.pl
sqlite3 reps.db .schema > tmpschema.sql
sqlite3 reps.db .dump > tmpdump.sql
grep -vx -f tmpschema.sql tmpdump.sql > dump1.sql
grep -vP "^(PRAGMA|COMMIT|BEGIN)" dump1.sql > dump.sql

npx wrangler d1 execute RepsDB --local --file ./schema.sql
npx wrangler d1 execute RepsDB --local --file ./dump.sql

rm -f tmpschema.sql tmpdump.sql dump1.sql reps.db reps.json
