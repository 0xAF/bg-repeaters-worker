#!/usr/bin/perl

use strict;
use warnings;
use open qw(:std :encoding(UTF-8));
use JSON;
use Getopt::Long qw(GetOptions);
use DBIx::Simple;
use Encode qw(encode);
binmode(STDOUT, ":encoding(UTF-8)");
binmode(STDERR, ":encoding(UTF-8)");

my $reps_json = 'reps.json';
my $sqlite_db = 'reps.db';
my $dump_sql  = '';
my $with_schema = 0;

GetOptions(
  'json=s'   => \$reps_json,
  'db=s'     => \$sqlite_db,
  'dump=s'   => \$dump_sql,     # path to write SQL dump (if provided, SQL will be written instead of executed)
  'schema!'  => \$with_schema,  # include schema.sql at the top of the dump
) or die "Invalid options\n";

# Read file as raw bytes; JSON decoder will handle UTF-8
sub slurp_utf8 {
  my ($path) = @_;
  open(my $fh, '<:raw', $path) or die "cannot open file $path";
  local $/; my $data = <$fh>; close($fh); return $data;
}

sub sql_quote {
  my ($v) = @_;
  return 'NULL' if (!defined $v);
  if (!ref($v) && $v =~ /^-?\d+(?:\.\d+)?$/) {
    # looks numeric
    return $v;
  }
  # ensure string
  $v = "$v";
  $v =~ s/'/''/g; # escape single quotes for SQL
  return "'$v'";
}

my $json = slurp_utf8($reps_json);
my $data = decode_json $json;

my $outfh;
my $db; # DBIx::Simple handle when executing directly
if ($dump_sql) {
  open($outfh, '>:encoding(UTF-8)', $dump_sql) or die "cannot open $dump_sql for writing";
  print $outfh "-- Generated from $reps_json\n"; #"BEGIN TRANSACTION;\n";
  if ($with_schema && -f 'schema.sql') {
    my $schema = slurp_utf8('schema.sql');
    print $outfh "\n-- Schema --\n$schema\n";
  }
} else {
  # connect to SQLite and execute
  $db = DBIx::Simple->connect("dbi:SQLite:dbname=$sqlite_db", { RaiseError => 1 }) or die DBIx::Simple->error;
  # Ensure SQLite handles Unicode properly when binding parameters
  eval { $db->dbh->{sqlite_unicode} = 1; };
}

my $reps = $data->{repeaters};
foreach my $k (sort keys %{$reps}) {
  my $r = $reps->{$k};
  if ($k !~ /^LZ0\w{3}$/) {
    warn "Skipping: $k\n";
    next;
  }
  my @lines = @{$r->{info} || []};
  my $info_full = join("\r\n", @lines);
  # Extract power in watts; avoid int() on undef if no match
  my ($power_match) = $info_full =~ /([\d\.]+)w/i;
  my $power = defined $power_match ? int($power_match) : undef;
  # Disabled flag comes from JSON (default 0)
  my $disabled = $r->{disabled} ? 1 : 0;
  my $fm = $r->{mode}->{analog} ? 1 : 0;
  my $usb = $info_full =~ /mode:\s*usb/i ? 1 : 0;
  $fm = 0 if ($usb);
  my $beacon = $info_full =~ /beacon/i ? 1 : 0;
  # Extract AllStarLink node ID; avoid int() on undef if no match
  my ($asl_match) = $info_full =~ /allstarlink.*:\s*(\d+)/i;
  my $asl = defined $asl_match ? int($asl_match) : undef;
  # Try to extract some digital details when possible (best-effort, optional)
  my ($dmr_cc) = $info_full =~ /(?:\bCC\b|dmr[^\n]*?cc|color\s*code)\s*[:=]?\s*(\d{1,2})/i;
  my ($dstar_module_declared) = $info_full =~ /d\s*\-?\s*star[^\n]*?module\s*[:=]?\s*([A-Z])/i;
  my ($dstar_gateway) = $info_full =~ /d\s*\-?\s*star[^\n]*?gateway\s*[:=]?\s*([A-Z0-9\-]+)/i;
  my ($fusion_room) = $info_full =~ /fusion[^\n]*?room\s*[:=]?\s*([A-Za-z0-9\-\s]+)/i;
  my ($fusion_dgid) = $info_full =~ /fusion[^\n]*?dgid\s*[:=]?\s*(\d{1,3})/i;
  my ($fusion_wiresx) = $info_full =~ /wires\s*[- ]?x[^\n]*?(?:id|node)\s*[:=]?\s*(\d{3,10})/i;
  my ($nxdn_ran) = $info_full =~ /nxdn[^\n]*?ran\s*[:=]?\s*(\d{1,2})/i;
  my ($nxdn_network) = $info_full =~ /nxdn[^\n]*?network\s*[:=]?\s*([A-Za-z0-9\-\s]+)/i;

  # Digital structured fields extraction
  my $dstar_info; # free-form info (from line starting with D-STAR:)
  my $dstar_reflector; my $dstar_module;
  # Reflector like XLX359B or XLX799 C
  if ($info_full =~ /(XLX(\d{3,})([A-Z])?)/i) {
    $dstar_reflector = uc($2 ? 'XLX'.$2 : $1);
    my $mod = $3; $dstar_module = uc($mod) if defined $mod && $mod =~ /[A-Z]/;
  }
  # Prefer explicit module declaration if present
  $dstar_module = $dstar_module_declared if (!$dstar_module && $dstar_module_declared);
  if ($info_full =~ /D\s*-?STAR\s*:\s*(.+)/i) { $dstar_info = $1; $dstar_info =~ s/\r?\n/ /g; }

  # DMR fields
  my $dmr_network; my $dmr_info; my $dmr_ts1_groups; my $dmr_ts2_groups; my $dmr_callid; my $dmr_reflector;
  if ($info_full =~ /DMR\s*:\s*(.+)/i) { $dmr_info = $1; $dmr_info =~ s/\r?\n/ /g; }
  if ($info_full =~ /(Brandmeister|FreeDMR|DMR\+)/i) { $dmr_network = uc($1); }
  # Network line may also contain a reflector after a comma, e.g. "Network: DMR+, XLX023 ipsc2"
  if ($info_full =~ /Network\s*:\s*(Brandmeister|FreeDMR|DMR\+)\s*,\s*([^\r\n]+)/i) {
    $dmr_network = uc($1);
    my $ref = $2; $ref =~ s/\s+$//; $dmr_reflector = $ref;
  }
  # Explicit DMR reflector tokens (e.g., XLX023, IPSC2, etc.) if not already captured; prefer the combined form above
  if (!$dmr_reflector && $info_full =~ /(XLX\d{3,}\s*\w*|IPSC2[^\r\n]*)/i) {
    my $ref = $1; $ref =~ s/\s+$//; $dmr_reflector = $ref;
  }
  # CallID: 284040 pattern
  if ($info_full =~ /CallID\s*[:=]\s*(\d{3,10})/i) { $dmr_callid = $1; }
  # Slot group extraction: collect talkgroup numbers appearing after slot indicators
  # @lines already set
  my (@tg1, @tg2);
  foreach my $line (@lines) {
    if ($line =~ /Slot\s*1|Slot1/i) {
      # Capture Slot1 segment up to Slot2 or end
      if ($line =~ /Slot\s*1\s*:\s*(.+?)(?=Slot\s*2\s*:|$)/i) {
        my $seg1 = $1;
        my @nums1 = ($seg1 =~ /TG\s*(\d{2,6})/ig); # explicit TG prefixes
        # Also capture bare numbers separated by commas/spaces within the segment
        my @bare1 = ($seg1 =~ /\b(\d{2,6})\b/g);
        # Merge, preferring TG extracted (avoid duplicates later)
        push @tg1, (@nums1, @bare1);
      }
    }
    if ($line =~ /Slot\s*2|Slot2/i) {
      if ($line =~ /Slot\s*2\s*:\s*(.+)$/i) {
        my $seg2 = $1;
        my @nums2 = ($seg2 =~ /TG\s*(\d{2,6})/ig);
        my @bare2 = ($seg2 =~ /\b(\d{2,6})\b/g);
        push @tg2, (@nums2, @bare2);
      }
    }
    # Bulgarian 'Статично' may list static groups; if context mentions slot 2 earlier treat as ts2
    if ($line =~ /Статично/i) {
      my @nums = ($line =~ /\b(\d{3,6})\b/g);
      # Heuristic: attach to ts2 if slot2 mentioned anywhere else, else ts1 if empty
      if (@nums) {
        if (@tg2) { push @tg2, @nums; } elsif (!@tg1) { push @tg1, @nums; } else { push @tg2, @nums; }
      }
    }
  }
  if (@tg1) { my %seen; @tg1 = grep { !$seen{$_}++ } @tg1; $dmr_ts1_groups = join(',', @tg1); }
  if (@tg2) { my %seen; @tg2 = grep { !$seen{$_}++ } @tg2; $dmr_ts2_groups = join(',', @tg2); }

  # Fusion fields (best-effort)
  my $fusion_reflector; my $fusion_tg; my $fusion_info;
  if ($info_full =~ /FUSION\s*:\s*(.+)/i) { $fusion_info = $1; $fusion_info =~ s/\r?\n/ /g; }
  if ($info_full =~ /(YSF\d{3,})/i) { $fusion_reflector = uc($1); }
  if ($info_full =~ /TG\s*(\d{2,6})/i && !$fusion_tg && $r->{mode}->{fusion}) { $fusion_tg = $1; }

  # DMR color code already in $dmr_cc -> rename semantics
  my $dmr_color_code = $dmr_cc;

  # Preserve the original info lines intact (per requirement)
  my $info = $info_full;
  my $coverage = encode_json $r->{coverage};
  $coverage = undef if (defined $coverage && $coverage =~ /null/);

  # Columns as per schema.sql order
  my @cols = qw(
    callsign disabled keeper latitude longitude place location info altitude power
    mode_fm mode_am mode_usb mode_lsb mode_dmr mode_dstar mode_fusion mode_nxdn mode_parrot mode_beacon
    freq_rx freq_tx tone net_echolink net_allstarlink net_zello net_other coverage_map_json
    dstar_reflector dstar_info
    fusion_reflector fusion_tg fusion_info
    dmr_network dmr_ts1_groups dmr_ts2_groups dmr_info
    dmr_color_code dmr_callid dmr_reflector
    dstar_module dstar_gateway
    fusion_room fusion_dgid fusion_wiresx_node
    nxdn_ran nxdn_network
  );

  # Prepare values matching the above columns; round lat/lon/tone in DB path; keep raw for dump
  my @vals = (
    $r->{callsign}, $disabled, $r->{keeper},
    defined $r->{lat} ? $r->{lat} : undef,
    defined $r->{lon} ? $r->{lon} : undef,
    $r->{loc}, $r->{locExtra}, $info, $r->{altitude}, $power,
    $fm, 0, $usb, 0,
    $r->{mode}->{dmr} ? 1 : 0,
    $r->{mode}->{dstar} ? 1 : 0,
    $r->{mode}->{fusion} ? 1 : 0,
    $r->{mode}->{nxdn} ? 1 : 0,
    $r->{mode}->{parrot} ? 1 : 0,
    $beacon,
  # JSON rx/tx are from the user's radio perspective.
  # Map to repeater perspective in DB (Hz):
  # - freq_rx (repeater RX) <= user's TX (json.tx)
  # - freq_tx (repeater TX) <= user's RX (json.rx)
  ($r->{tx} || 0) * 1000 * 1000,
  ($r->{rx} || 0) * 1000 * 1000,
    $r->{tone},
    $r->{echolink} ? $r->{echolink} : 0,
    $asl,
    $r->{zello},
    undef, # net_other
    $coverage,
  # Digital details extracted above (may be undef)
  $dstar_reflector,
  $dstar_info,
  $fusion_reflector,
  $fusion_tg,
  $fusion_info,
  $dmr_network,
  $dmr_ts1_groups,
  $dmr_ts2_groups,
  $dmr_info,
  $dmr_color_code,
  $dmr_callid,
  $dmr_reflector,
  $dstar_module,
  $dstar_gateway,
  $fusion_room,
  $fusion_dgid,
  $fusion_wiresx,
  $nxdn_ran,
  $nxdn_network,
  );

  if ($dump_sql) {
    # Build INSERT with explicit columns; include created/updated only if provided
    my @dump_cols = @cols;
    my @dump_vals = @vals;
    if (defined $r->{recordCreated} && defined $r->{recordUpdated}) {
      push @dump_cols, ('created', 'updated');
      push @dump_vals, ($r->{recordCreated}, $r->{recordUpdated});
    }
    my $sql = 'INSERT INTO repeaters (' . join(', ', @dump_cols) . ') VALUES(' . join(',', map { sql_quote($_) } @dump_vals) . ");\n";
    print $outfh $sql;
  } else {
    eval {
      # Encode textual values to UTF-8 bytes to avoid wide-character warnings
      my @vals_db = map { defined $_ && !ref($_) ? encode('UTF-8', "$_") : $_ } @vals;
      # Append created/updated for DB path; use COALESCE to default to now when missing
      my ($created, $updated) = ($r->{recordCreated}, $r->{recordUpdated});
      push @vals_db, ($created, $updated);
      my $sql = qq{INSERT INTO repeaters (
        callsign, disabled, keeper, latitude, longitude, place, location, info, altitude, power,
        mode_fm, mode_am, mode_usb, mode_lsb, mode_dmr, mode_dstar, mode_fusion, mode_nxdn, mode_parrot, mode_beacon,
        freq_rx, freq_tx, tone, net_echolink, net_allstarlink, net_zello, net_other, coverage_map_json,
        dstar_reflector, dstar_info, fusion_reflector, fusion_tg, fusion_info, dmr_network, dmr_ts1_groups, dmr_ts2_groups, dmr_info,
        dmr_color_code, dstar_module, dstar_gateway, fusion_room, fusion_dgid, fusion_wiresx_node, nxdn_ran, nxdn_network,
        created, updated
      ) VALUES (
        ?, ?, ?, ROUND(?, 7), ROUND(?, 7), ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ROUND(?, 1), ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE(?, datetime('now')), COALESCE(?, datetime('now'))
      )};
      $db->query($sql, @vals_db);
    };
    if ($@) {
      warn "Error inserting repeater $k: $@";
      die $db->error;
    }
  }
}

my $changelog = $data->{changelog};
foreach my $k (sort keys %{$changelog}) {
  my @a = @{$changelog->{$k}};
  my $str = '';
  foreach my $c (@a) {
    $c .= '.';
    $c =~ s/\.+$/. /;
    $str .= $c;
  }
  $str =~ s/\s+$//;
  my @vals = ($k, 'LZ2SLL', $str);
  if ($dump_sql) {
    my $sql = 'INSERT INTO changelog VALUES(' . join(',', map { sql_quote($_) } @vals) . ");\n";
    print $outfh $sql;
  } else {
    eval {
      my @vals_db = map { defined $_ && !ref($_) ? encode('UTF-8', "$_") : $_ } @vals;
      $db->query(qq{INSERT INTO changelog VALUES (?, ?, ?)}, @vals_db)
    };
    if ($@) {
      warn "Error inserting changelog $k: $@";
      die $db->error;
    }
  }
}

if ($dump_sql) {
  # print $outfh "COMMIT;\n";
  close($outfh);
}
