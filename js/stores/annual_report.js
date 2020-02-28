import { Map } from 'immutable';
import { Store } from 'flux/utils';
import dispatcher from '../util/dispatcher';
import { types } from '../actions/report';
import annualReportDataFormStore from './annual_report_data_form';
import FoiaAnnualReportUtilities from '../util/foia_annual_report_utilities';
import FoiaAnnualReportFilterUtilities from '../util/foia_annual_report_filter_utilities';

// Function to output button in headers.
function headingAsButton(cell) {
  return `<button class="unstyled-button"> ${cell.getValue()} </button>`;
}

class AnnualReportStore extends Store {
  constructor(_dispatcher) {
    super(_dispatcher);
    this.initializeState();
  }

  initializeState() {
    this.state = {
      reports: new Map(),
      reportTables: new Map(),
      reportDataComplete: false,
      reportDataHasRows: false,
      // The number of data types requested on the front end form.  Separate api requests
      // will be made for each data type so that filters, or the lack of filters for one
      // data type, don't adversely affect the results, which should be more inclusive, not less.
      numberOfTypesToProcess: 0,
    };
  }

  getState() {
    return this.state;
  }


  static getSelectedAgencies() {
    const selectedAgencies = annualReportDataFormStore.buildSelectedAgencies();
    return selectedAgencies.reduce((formatted, selected) => {
      switch (selected.type) {
        case 'agency': {
          const { abbreviation, components } = selected;
          const selectedComponents = formatted[abbreviation] || [];
          const componentAbbreviations = components
            .filter(component => component.selected)
            .map(component => component.abbreviation);

          formatted[abbreviation] = selectedComponents.concat(...componentAbbreviations.toArray())
            .filter((value, index, array) => array.indexOf(value) === index)
            .sort();
          break;
        }
        case 'agency_component': {
          const { abbreviation, agency } = selected;
          const agencyComponents = formatted[agency.abbreviation] || [];
          formatted[agency.abbreviation] = agencyComponents
            .concat(abbreviation)
            .filter((value, index, array) => array.indexOf(value) === index)
            .sort();
          break;
        }
        default: {
          break;
        }
      }

      return formatted;
    }, {});
  }

  getReportDataForType(dataType) {
    // @todo: Filter rows based on data type filters.
    const componentData = [];
    const overallData = [];
    const { reports } = this.state;
    const selectedAgencies = AnnualReportStore.getSelectedAgencies();

    // Iterate over each report.
    reports.forEach((report) => {
      const { abbreviation: agency_abbr, name: agency_name } = report.get('field_agency');
      const selectedComponents = [...selectedAgencies[agency_abbr] || []];
      // When all agencies are selected, only overall fields are retrieved, so the
      // getDataForType() function call will fail.
      const flattened = FoiaAnnualReportUtilities.getDataForType(report, dataType);
      const overall = FoiaAnnualReportUtilities.getOverallDataForType(report, dataType);

      selectedComponents.forEach((component) => {
        const fiscal_year = report.get('field_foia_annual_report_yr');
        const defaults = {
          field_agency_component: component,
          field_agency: agency_name,
          field_foia_annual_report_yr: fiscal_year,
        };
        const allRows = component.toLowerCase() === 'agency overall' ? overall : flattened;

        // It is not guaranteed that the flattened data will be keyed by
        // a component abbreviation.  This gathers an array of all the rows
        // for this component.
        const componentRows = Object.keys(allRows).map((key) => {
          if (allRows[key].field_agency_component !== component) {
            return false;
          }

          return allRows[key];
        }).filter(value => value !== false);

        // Filtering via the api will return reports that match the filter criteria,
        // but will not filter out components within those reports that don't match the
        // filter criteria.  This takes a pass over each row for this data type to filter
        // out any component row that does not match the data type filter criteria.
        const filtered = FoiaAnnualReportFilterUtilities.filter(
          componentRows,
          FoiaAnnualReportFilterUtilities.getFiltersForType(dataType.id),
        );

        const normalized = filtered.map(row => (
          // Normalization essentially checks every field to see if it's
          // an object with a value property.  If it is, it sets the field to the
          // field.value, allowing tablulator to use the ids in report_data_map.json.
          Object.assign({}, defaults, FoiaAnnualReportUtilities.normalize(row))
        ));

        if (component.toLowerCase() === 'agency overall') {
          overallData.push(...normalized);
        } else {
          componentData.push(...normalized);
        }
      });
    });

    return componentData.concat(overallData);
  }

  __onDispatch(payload) {
    switch (payload.type) {
      case types.ANNUAL_REPORT_DATA_FETCH: {
        const { typesCount } = payload;
        // Reset the report data to initial value so that report state after a new form submission
        // is limited to only the data specific to that request.
        this.state.reportDataComplete = false;
        Object.assign(this.state, {
          reports: new Map(),
          numberOfTypesToProcess: typesCount || 1,
        });
        this.__emitChange();
        break;
      }

      case types.ANNUAL_REPORT_DATA_RECEIVE: {
        const { reports } = this.state;

        const updatedReports = reports.withMutations((mutableReports) => {
          payload.annualReports.forEach((report) => {
            // Merge new values if a report already exists since most report requests won't
            // contain all data.
            if (mutableReports.has(report.id)) {
              mutableReports.update(
                report.id,
                previousValue => previousValue.merge(new Map(report)),
              );
            } else {
              mutableReports.set(report.id, new Map(report));
            }
          });
        });

        Object.assign(this.state, {
          reports: updatedReports,
        });
        this.__emitChange();

        break;
      }

      case types.ANNUAL_REPORT_DATA_COMPLETE: {
        // Resets focus to skip nav so tabbing doesn't default to footer before results load.
        document.getElementById('skipnav').focus();

        // If there are multiple data types requested, separate requests will be
        // made for each data type.  Avoid building the report tables until all
        // of the data type requests have finished processing.
        if (this.state.numberOfTypesToProcess > 1) {
          Object.assign(this.state, {
            numberOfTypesToProcess: this.state.numberOfTypesToProcess - 1,
          });
          this.__emitChange();
          break;
        }

        const { selectedDataTypes } = annualReportDataFormStore.getState();
        // Set up the default columns that appear in all data tables.
        const defaultColumns = [
          {
            title: 'Agency',
            titleFormatter: headingAsButton,
            field: 'field_agency',
            align: 'center',
          },
          {
            title: 'Component',
            titleFormatter: headingAsButton,
            field: 'field_agency_component',
            align: 'center',
          },
          {
            title: 'Fiscal Year',
            titleFormatter: headingAsButton,
            field: 'field_foia_annual_report_yr',
            align: 'center',
          },
        ];

        const tables = [];
        const isOverallOnly = FoiaAnnualReportFilterUtilities.filterOnOverallFields();
        selectedDataTypes.forEach((dataType) => {
          if (!tables.some(item => item.id === dataType.id)) {
            // Get our dataType-specific columns.
            const dataColumns = dataType.fields
              .filter(field => field.display && (!isOverallOnly || field.overall_field))
              .map(item => (
                {
                  title: item.label,
                  titleFormatter: headingAsButton,
                  field: item.id,
                  align: 'center',
                }));
            const reportHeaders = defaultColumns.concat(dataColumns);
            const dataRows = this.getReportDataForType(dataType);
            tables.push({
              id: dataType.id,
              header: dataType.heading,
              columns: reportHeaders,
              data: dataRows,
            });
          }
        });

        // Check to see that at least one table contains some data rows.
        const hasRows = tables.some(table => table.data.length > 0);

        const updatedReportTables = new Map(tables.map(table => ([
          table.id,
          table,
        ])));

        Object.assign(this.state, {
          reportTables: updatedReportTables,
          reportDataComplete: true,
          reportDataHasRows: hasRows,
          numberOfRequestsToProcess: 0,
        });

        this.__emitChange();
        break;
      }

      case types.CLEAR_FORM: {
        this.initializeState();
        this.__emitChange();
        break;
      }

      default:
        break;
    }
  }
}

const annualReportStore = new AnnualReportStore(dispatcher);

export default annualReportStore;

export {
  AnnualReportStore,
};
