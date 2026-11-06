/** Physical sizes for the 3D scene, mm. */
export const BOARD_THICKNESS_MM = 1.6
export const HOLE_DIAMETER_MM = 1.0
export const PAD_DIAMETER_MM = 1.8
export const COPPER_THICKNESS_MM = 0.05
export const BARE_WIRE_DIAMETER_MM = 0.6
export const INSULATED_WIRE_DIAMETER_MM = 1.4
export const LEG_DIAMETER_MM = 0.6
/** How far legs stick out below the bottom surface. */
export const LEG_BELOW_MM = 1.5
export const SOLDER_BASE_DIAMETER_MM = 1.8
export const SOLDER_HEIGHT_MM = 0.9
/** y of the bottom surface; the top surface is y = 0. */
export const BOARD_BOTTOM_Y = -BOARD_THICKNESS_MM
/** y of a leg's cut end under the board. */
export const LEG_END_Y = BOARD_BOTTOM_Y - LEG_BELOW_MM

export const COLORS = {
  board: '#8a7a45',
  pad: '#c9ccc4',
  copper: '#b87333',
  insulatedFallback: '#1f6fb2',
  leg: '#c3c7cb',
  solder: '#a9aeb3',
  bridge: '#c8c8c8',
  black: '#1d1f21',
  relay: '#2f4f7a',
  tab: '#c0c4c8',
  terminal: '#2f8f4e',
  headerPin: '#d4af37',
  polyfuse: '#e3c23a',
  resistor: '#d9c7a0',
  diode: '#1d1f21',
  diodeStripe: '#9aa0a6',
  capDisc: '#d9822b'
} as const
