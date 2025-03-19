#!/usr/bin/perl

use JSON;
use DDP;
use DBIx::Simple;
binmode(STDOUT, ":encoding(UTF-8)");
binmode(STDERR, ":encoding(UTF-8)");

my $json;
open(my $fh, '<', "reps.json") or die "cannot open file reps.json";
{ local $/; $json = <$fh>; }
close($fh);

my $db = DBIx::Simple->connect('dbi:SQLite:dbname=reps.db', { RaiseError => 1 }) or die DBIx::Simple->error;
my $data = decode_json $json;

my $reps = $data->{repeaters};
foreach my $k (sort keys %{$reps}) {
  my $r = $reps->{$k};
  if ($k !~ /^LZ0\w{3}$/) {
    warn "Skipping: $k\n";
    next;
  }
  my $info = join("\r\n", @{$r->{info}});
  my ($power) = $info =~ /([\d\.]+)w/i; $power = int($power);
  my $fm = $r->{mode}->{analog} ? 1 : 0;
  my $usb = $info =~ /mode:\s*usb/i ? 1 : 0;
  $fm = 0 if ($usb);
  my $beacon = $info =~ /beacon/i ? 1 : 0;
  my ($asl) = $info =~ /allstarlink.*:\s*(\d+)/i; $asl = int($asl);
  my $coverage = encode_json $r->{coverage};
  $coverage = undef if ($coverage =~ /null/);

  # (my $info1 = $info) =~ s/\r\n/ /g;
  # print "$k: power: $power, fm: $fm, usb: $usb, beacon: $beacon, asl: $asl, info: $info1, coverage: $coverage\n";
  # next;

  eval {
    $db->query(qq{INSERT INTO repeaters VALUES (
        ?, ?, ?, ROUND(?, 7), ROUND(?, 7), ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ROUND(?, 1),
        ?, ?, ?, ?,
        ?,
        ?, ?
      )},
      $r->{callsign}, 0, $r->{keeper}, $r->{lat}, $r->{lon}, $r->{loc}, $r->{locExtra}, $info, $r->{altitude}, $power,
      $fm, 0, $usb, 0, $r->{mode}->{dmr} ? 1 : 0, $r->{mode}->{dstar} ? 1 : 0, $r->{mode}->{fusion} ? 1 : 0, $r->{mode}->{parrot} ? 1 : 0, $beacon,
      $r->{tx} * 1000 * 1000, $r->{rx} * 1000 * 1000, $r->{tone},
      $r->{echolink} ? $r->{echolink} : 0, $asl, $r->{zello}, undef,
      $coverage,
      $r->{recordCreated}, $r->{recordUpdated}
    )
  };
  if ($@) {
    warn p $r;
    warn p $@;
    die $db->error;
  }
}

my $changelog = $data->{changelog};
foreach my $k (sort keys %{$changelog}) {
  my @a = @{$changelog->{$k}};
  my $str;
  foreach my $c (@a) {
    $c.=".";
    $c=~s/\.+$/\. /;
    $str.=$c;
  }
  $str =~ s/\s+$//;
  eval {
    $db->query(qq{INSERT INTO changelog VALUES (?, ?, ?)},
      $k, 'LZ2SLL', $str
    )
  };
  if ($@) {
    warn p $k;
    warn p $@;
    die $db->error;
  }

}
