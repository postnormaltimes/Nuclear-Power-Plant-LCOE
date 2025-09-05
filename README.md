<div align="center">

<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

  <h1>Built with AI Studio</h2>

  <p>The fastest path from prompt to production with Gemini.</p>

  <a href="https://aistudio.google.com/apps">Start building</a>

</div>

## Financial Model

The repository includes `financial_model.py`, a Python module that builds a discounted cash-flow model for a nuclear power plant. Key features:

- **Year-end discounting** across the entire project horizon of construction years plus useful life.
- **Interest during construction (IDC)** can be evaluated under a Standard or RAB approach. The Standard model compounds unpaid interest, while the RAB model applies interest only to the portion of overnight construction cost (OCC) spent to date. Accrued IDC still contributes to the LCOE numerator.
- **Valuation point** can be set at start of construction (SOC) or commercial operation date (COD). Expenses are discounted from SOC, while energy revenues are discounted from SOC or COD depending on the selected option.

Run the module directly to see an example calculation:

```bash
python financial_model.py
```
