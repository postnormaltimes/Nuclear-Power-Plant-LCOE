from dataclasses import dataclass
from typing import Literal, Tuple


def calculate_lcoe(
    occ: float,
    construction_years: int,
    useful_life: int,
    discount_rate: float,
    interest_rate: float,
    energy_per_year: float,
    model: Literal["standard", "rab"] = "standard",
    valuation_point: Literal["soc", "cod"] = "soc",
) -> Tuple[float, float]:
    """Calculate the levelized cost of energy (LCOE).

    Parameters
    ----------
    occ : float
        Overnight construction cost of the project.
    construction_years : int
        Number of years required to build the project.
    useful_life : int
        Operational life of the project in years.
    discount_rate : float
        Discount rate used to bring future cash flows to present value.
    interest_rate : float
        Interest rate used to compute interest during construction (IDC).
    energy_per_year : float
        Energy generated in each operational year.
    model : {"standard", "rab"}, optional
        Interest calculation approach:
            * "standard" – interest accrues on both OCC spent to date and
              previously accrued, unpaid interest (compound IDC).
            * "rab" – interest accrues only on OCC spent to date (no
              compounding).  IDC still enters the LCOE numerator as a cost.
    valuation_point : {"soc", "cod"}, optional
        Valuation point for discounting energy revenues:
            * "soc" – revenues discounted from start of construction.  The
              revenue in year i of operations is discounted as if it occurs
              at year ``construction_years + i``.
            * "cod" – revenues discounted from commercial operation date.
              The revenue in year i of operations is discounted as if it
              occurs at year ``i``.

    Returns
    -------
    lcoe : float
        Levelized cost of energy.
    total_idc : float
        Total interest during construction accrued over the construction
        period.
    """

    occ_per_year = occ / construction_years
    occ_spent_to_date = 0.0
    accrued_interest = 0.0
    cost_pv = 0.0

    # Discounting uses year-end convention.  Year numbering begins at 1.
    for year in range(1, construction_years + 1):
        occ_spent_to_date += occ_per_year
        if model == "standard":
            principal = occ_spent_to_date + accrued_interest
        elif model == "rab":
            principal = occ_spent_to_date
        else:
            raise ValueError("model must be 'standard' or 'rab'")

        interest = principal * interest_rate
        accrued_interest += interest
        total_cash = occ_per_year + interest
        cost_pv += total_cash / ((1 + discount_rate) ** year)

    total_idc = accrued_interest

    pv_energy = 0.0
    for year in range(1, useful_life + 1):
        if valuation_point == "soc":
            discount_year = construction_years + year
        elif valuation_point == "cod":
            discount_year = year
        else:
            raise ValueError("valuation_point must be 'soc' or 'cod'")

        pv_energy += energy_per_year / ((1 + discount_rate) ** discount_year)

    lcoe = cost_pv / pv_energy
    return lcoe, total_idc


if __name__ == "__main__":
    # Example usage with dummy numbers
    lcoe, idc = calculate_lcoe(
        occ=1_000_000_000,
        construction_years=5,
        useful_life=40,
        discount_rate=0.07,
        interest_rate=0.05,
        energy_per_year=8_000_000,
        model="standard",
        valuation_point="soc",
    )
    print(f"LCOE: {lcoe:.2f}, Total IDC: {idc:,.0f}")
