import { z } from '@hono/zod-openapi'





const callsign = z
  .string()
  .length(6)
  .toUpperCase()
  .startsWith('LZ0')
  .regex(/LZ0\w{3}/)
  .openapi({
    description: "Repeater callsign/name",
    example: 'LZ0BOT',
  })

const disabled = z
  .coerce
  .boolean()
  .optional()
  .openapi({
    description: "Is the repeater active",
    example: false,
    default: false,
  })

const keeper = z
  .string()
  .min(5)
  .max(6)
  .toUpperCase()
  .startsWith('LZ')
  .regex(/LZ[1-9]\w{2,3}/)
  .openapi({
    description: "The keeper of the repeater",
    example: 'LZ2SLL',
  })
const latitude = z
  .number()
  .min(-90)
  .max(90)
  .openapi({
    description: "GPS latitude",
    example: 42.717692,
  })
const longitude = z
  .number()
  .min(-180)
  .max(180)
  .openapi({
    description: "GPS longitude",
    example: 24.917145,
  })
const place = z
  .string()
  .openapi({
    description: "City or place",
    example: "вр.Ботев",
  })
const location = z
  .string()
  .optional()
  .openapi({
    description: "The exact location",
    example: "връх Ботев (НУРТС)",
  })
const info = z
  .string()
  .array()
  .optional()
  .openapi({
    description: "Extra information",
    example: ["Ретранслатор с национално значение.", "Покрива България и части от съседните държави."],
  })
const altitude = z
  .number()
  .openapi({
    description: "Altitude (Elevation above sea level) in meters",
    example: 2376,
    default: 0,
  })
const power = z
  .number()
  .optional()
  .openapi({
    description: "Transmit power of the repeater in Watts",
    example: 50,
    default: 0,
  })

const modes_fm = z
  .boolean()
  .optional()
  .openapi({
    description: "Supports FM mode"
  })

const modes_am = z
  .boolean()
  .optional()
  .openapi({
    description: "Supports AM mode"
  })

const modes_usb = z
  .boolean()
  .optional()
  .openapi({
    description: "Supports USB mode"
  })

const modes_lsb = z
  .boolean()
  .optional()
  .openapi({
    description: "Supports LSB mode"
  })

const modes_dmr = z
  .boolean()
  .optional()
  .openapi({
    description: "Supports DMR mode"
  })

const modes_dstar = z
  .boolean()
  .optional()
  .openapi({
    description: "Supports DSTAR mode"
  })

const modes_fusion = z
  .boolean()
  .optional()
  .openapi({
    description: "Supports FUSION/C4FM mode"
  })

const modes_nxdn = z
  .boolean()
  .optional()
  .openapi({
    description: "Supports NXDN mode"
  })

const modes_parrot = z
  .boolean()
  .optional()
  .openapi({
    description: "Repeater is a parrot"
  })

const modes_beacon = z
  .boolean()
  .optional()
  .openapi({
    description: "Repeater is a beacon"
  })

const modes = z
  .object({
    fm: modes_fm,
    am: modes_am,
    usb: modes_usb,
    lsb: modes_lsb,
    dmr: modes_dmr,
    dstar: modes_dstar,
    fusion: modes_fusion,
    nxdn: modes_nxdn,
    parrot: modes_parrot,
    beacon: modes_beacon,
  })
  .openapi({
    description: "Available modes for the repeater",
    example: {
      fm: true,
      dmr: true,
      dstar: true,
      fusion: true,
      nxdn: true,
    }
  })


const freq_rx = z
  .number()
  .positive()
  .openapi({
    description: "Repeater's receive frequency in Hz",
    example: 430700000
  })

const freq_tx = z
  .number()
  .positive()
  .openapi({
    description: "Repeater's transmit frequency in Hz",
    example: 438300000
  })

const freq_tone = z
  .number()
  .optional()
  .openapi({
    description: "Repeater's TX/RX Tone (CTCSS)",
    example: 79.7
  })

const channel = z
  .string()
  .optional()
  .openapi({
    description: "Channel designation for the repeater"
  })

const freq = z
  .object({
    rx: freq_rx,
    tx: freq_tx,
    tone: freq_tone,
    channel,
  })
  .openapi({
    description: "RX, TX and Tone (CTCSS) frequencies the repeater",
    example: { rx: 145.050, tx: 145.650, tone: 79.7 }
  })

const internet_echolink = z
  .number()
  .optional()
  .openapi({
    description: "Echolink address",
    example: 9870
  })

const internet_allstarlink = z
  .number()
  .optional()
  .openapi({
    description: "AllStarLink address",
    example: 0
  })

const internet_zello = z
  .string()
  .optional()
  .openapi({
    description: "Zello information",
  })

const internet_other = z
  .string()
  .optional()
  .openapi({
    description: "Other internet connectivity information",
  })

const internet = z
  .object({
    echolink: internet_echolink,
    allstarlink: internet_allstarlink,
    zello: internet_zello,
    other: internet_other,
  })
  .optional()
  .openapi({
    description: "Internet connectivity",
    example: { echolink: 9870 }
  })
const coverage_map_json = z
  .string()
  .optional()
  .openapi({
    description: "Extra info for the coverage map in JSON",
  })
const added = z
  .date()
  .optional()
  .openapi({
    description: "Date of addition to the database"
  })
const updated = z
  .date()
  .optional()
  .openapi({
    description: "Date of last update"
  })

const qth = z
  .string()
  .optional()
  .openapi({
    description: "Maidenhead locator (QTH)"
  })


const RepeaterSchema = z.object({
  callsign,
  disabled,
  keeper,
  latitude,
  longitude,
  place,
  location,
  qth,
  info,
  altitude,
  power,
  modes,
  freq,
  internet,
  coverage_map_json,
  added,
  updated,
}).openapi('RepeaterSchema')


const RepeaterRequestSchema = z.object({
  callsign,
}).openapi('RepeaterRequestSchema')






const have_fm = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Supports FM mode"
  })

const have_am = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Supports AM mode"
  })

const have_usb = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Supports USB mode"
  })

const have_lsb = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Supports LSB mode"
  })

const have_dmr = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Supports DMR mode"
  })

const have_dstar = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Supports DSTAR mode"
  })

const have_fusion = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Supports FUSION/C4FM mode"
  })

const have_nxdn = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Supports NXDN mode"
  })

const have_parrot = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Repeaters that work as a parrot"
  })

const have_beacon = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Repeaters that work as a beacon"
  })

const have_rx_from = z
  .coerce
  .number()
  .positive()
  .openapi({
    description: "Repeaters with RX Freq >= X (in Hz)",
    example: 430000000
  })

const have_rx_to = z
  .coerce
  .number()
  .positive()
  .openapi({
    description: "Repeaters with RX Freq <= X (in Hz)",
    example: 440000000
  })

const have_tx_from = z
  .coerce
  .number()
  .positive()
  .openapi({
    description: "Repeaters with TX Freq >= X (in Hz)",
    example: 430000000
  })

const have_tx_to = z
  .coerce
  .number()
  .positive()
  .openapi({
    description: "Repeaters with TX Freq <= X (in Hz)",
    example: 440000000
  })

const have_tone = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Repeaters with tone (CTCSS)"
  })

const have_echolink = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Repeaters with Echolink"
  })

const have_allstarlink = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Repeaters with AllStarLink"
  })

const have_zello = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Repeaters with Zello"
  })

const have_other = z
  .enum(["false", "true", "0", "1"]).transform((value) => value == "true" || value == "1").pipe(z.boolean())
  .optional()
  .openapi({
    description: "Repeaters with Other Internet connectivity"
  })



const RepeaterQuerySchema = z.object({
  callsign,
  keeper,
  place,
  location,
  info,
  have_rx_from,
  have_rx_to,
  have_tx_from,
  have_tx_to,
  have_tone,
  have_fm,
  have_am,
  have_usb,
  have_lsb,
  have_dmr,
  have_dstar,
  have_fusion,
  have_nxdn,
  have_parrot,
  have_beacon,
  have_echolink,
  have_allstarlink,
  have_zello,
  have_other,

  // .openapi({
  //   description: "Object with search params",
  //   example: {rx_from: 430000000, rx_to: 440000000, dmr: true}
  // })
}).openapi('RepeaterRequestSchema')


const RepeaterQueryInternalSchema = z.object({
  callsign,
  keeper,
  place,
  location,
  info,
  have: z
    .object({
      rx: z
        .object({
          from: have_rx_from,
          to: have_rx_to,
        }).optional(),
      tx: z
        .object({
          from: have_tx_from,
          to: have_tx_to,
        }).optional(),
      tone: have_tone,
      fm: have_fm,
      am: have_am,
      usb: have_usb,
      lsb: have_lsb,
      dmr: have_dmr,
      dstar: have_dstar,
      fusion: have_fusion,
      nxdn: have_nxdn,
      parrot: have_parrot,
      beacon: have_beacon,
      echolink: have_echolink,
      allstarlink: have_allstarlink,
      zello: have_zello,
      other: have_other,
    })
    .optional()
}).openapi('RepeaterRequestSchema')


export { RepeaterSchema, RepeaterRequestSchema, RepeaterQuerySchema, RepeaterQueryInternalSchema }