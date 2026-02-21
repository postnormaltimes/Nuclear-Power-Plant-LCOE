
export interface LcoeInputs {
  usefulLife: number;
  overnightCost: number;
  constructionTime: number;
  wacc: number;
  fuelCost: number;
  omCost: number;
  loadHours: number;
  decommissioningCost: number;
}

export interface LcoeResult {
  totalLcoe: number;
  occLcoe: number;
  financingLcoe: number;
  fuelLcoe: number;
  omLcoe: number;
  decommissioningLcoe: number;
}
