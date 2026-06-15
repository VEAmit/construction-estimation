import { registerLicense } from '@syncfusion/ej2-base'

const licenseKey =
  window.syncfusionLicenseKey ||
  import.meta.env.VITE_SYNCFUSION_LICENSE ||
  'Ngo9BigBOggjHTQxAR8/V1NNaF5cXmBCf1FpRmJGdld5fUVHYVZUTXxaS00DNHVRdkdmWXpedHZWQ2BeVEdwXUdWYUA='

if (licenseKey) {
  registerLicense(licenseKey)
  window.syncfusionLicenseKey = licenseKey
}
