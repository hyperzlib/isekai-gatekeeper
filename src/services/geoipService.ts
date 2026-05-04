import { AppConfig, GeoIPConfig } from "../types/config";
import maxmind, { AsnResponse, CityResponse, CountryResponse, Reader } from 'maxmind';

export type GeoIPInfo = {
  ip: string;
  asn?: number;
  as_org?: string;
  continentCode?: string;
  countryCode?: string;
  city?: string;
  location?: {
    lat: number;
    lon: number;
  };
  timezone?: string;
}

export class GeoIPService {
  private config?: GeoIPConfig;

  private asnLookup?: Reader<AsnResponse>;
  private cityLookup?: Reader<CityResponse>;
  private countryLookup?: Reader<CountryResponse>;

  constructor(appConfig: AppConfig) {
    this.config = appConfig.geoip;
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /** 加载所有数据库 */
  public async init(): Promise<void> {
    if (this.config?.enabled) {
      if (this.config.db_asn_path) {
        try {
          this.asnLookup = await maxmind.open<AsnResponse>(this.config.db_asn_path);
          console.log(`[geoip] ASN database loaded from ${this.config.db_asn_path}`);
        } catch (err) {
          console.error(`[geoip] Failed to load ASN database from ${this.config.db_asn_path}:`, err instanceof Error ? err.message : err);
        }
      }
      
      if (this.config.db_city_path) {
        try {
          this.cityLookup = await maxmind.open<CityResponse>(this.config.db_city_path);
          console.log(`[geoip] City database loaded from ${this.config.db_city_path}`);
        } catch (err) {
          console.error(`[geoip] Failed to load City database from ${this.config.db_city_path}:`, err instanceof Error ? err.message : err);
        }
      } else if (this.config.db_country_path) {
        // city 数据库包含 country 数据，仅在未提供 city 数据库时才加载 country 数据库
        try {
          this.countryLookup = await maxmind.open<CountryResponse>(this.config.db_country_path);
          console.log(`[geoip] Country database loaded from ${this.config.db_country_path}`);
        } catch (err) {
          console.error(`[geoip] Failed to load Country database from ${this.config.db_country_path}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  public async close(): Promise<void> {

  }

  public lookup(ip: string): GeoIPInfo | null {
    if (!this.config?.enabled) {
      return null;
    }

    let info: GeoIPInfo = { ip };

    try {
      if (this.asnLookup) {
        const asnData = this.asnLookup.get(ip);
        if (asnData) {
          info.asn = asnData.autonomous_system_number;
          info.as_org = asnData.autonomous_system_organization;
        }
      }

      if (this.cityLookup) {
        const cityData = this.cityLookup.get(ip);
        if (cityData) {
          info.continentCode = cityData.continent?.code;
          info.countryCode = cityData.country?.iso_code;
          info.city = cityData.city?.names?.en;
          if (cityData.location) {
            info.location = {
              lat: cityData.location.latitude,
              lon: cityData.location.longitude,
            };
            info.timezone = cityData.location.time_zone;
          }
        }
      }

      if (this.countryLookup) {
        const countryData = this.countryLookup.get(ip);
        if (countryData) {
          info.continentCode = countryData.continent?.code;
          info.countryCode = countryData.country?.iso_code;
        }
      }
    } catch (err) {
      console.error(`[geoip] Failed to lookup IP ${ip}:`, err instanceof Error ? err.message : err);
    }

    return info;
  }
}