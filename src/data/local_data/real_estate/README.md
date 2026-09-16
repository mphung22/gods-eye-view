# Real estate

Parcel-level listing features for the `local-realestate` layer.

- Runtime file: `listings.geojsonl`
- Generator: `scripts/build-real-estate-dataset.mjs`
- Generator input (checked in): `example-listings.csv`
- Feature count: 20

## ⚠️ The bundled file is EXAMPLE DATA, not market data

`listings.geojsonl` ships with twenty synthetic Austin, TX records so the layer
renders, is testable, and demonstrates the card copy without shipping anyone's
licensed feed. Every row carries `"source": "EXAMPLE"`. The addresses are real
street locations with invented prices, statuses, days-on-market and rent
estimates. **Nothing in it is an observation of any real property**, and none of
the numbers should be read as a market signal.

Replace it before drawing any conclusion from the layer.

## Refreshing with real data

The runtime only ever reads the `.geojsonl`, so the refresh path is: produce a
CSV, convert it, replace the file.

```bash
node scripts/build-real-estate-dataset.mjs my-listings.csv \
  src/data/local_data/real_estate/listings.geojsonl
```

Required columns are latitude and longitude (`lat`/`lon`, `latitude`/`longitude`
or `x`/`y`). These optional columns are passed through when present and drive
the label priority and card copy: `address`, `city`, `state`, `zip`, `status`,
`days_on_market`, `list_price`, `rent_estimate`, `beds`, `baths`, `sqft`,
`as_of`, `source`. Rows with no usable coordinate are skipped and counted — read
that count, since it usually means the geocoding step failed rather than that
the rows were empty.

`status` is free text, lowercased for display. `foreclosure` additionally raises
a feature's label priority so distressed parcels survive the declutter budget at
lower zooms.

## Licensing — read before replacing the file

The example data carries no restrictions because it is invented. **A real
dataset almost certainly will.** Listing feeds from Zillow, Realtor, Estated,
RealtyMole/Rentcast, Rentometer and most MLS-derived sources are licensed, and
several prohibit redistribution outright — committing their output to a public
repository can breach the provider's terms even when your own API access is
legitimate.

Before replacing `listings.geojsonl` in a repository you publish:

1. Check the provider's terms for redistribution and caching limits.
2. Prefer public-record sources (county assessor and clerk foreclosure filings,
   which are typically public) over commercial feeds for anything committed.
3. If the data cannot be redistributed, keep it out of Git — point
   `listings.geojsonl` at a git-ignored path or generate it at deploy time.

Recording the source, extraction date and license here at the same time you
replace the file is what keeps that answerable later.
