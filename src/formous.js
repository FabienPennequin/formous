// @flow

import React, { Component } from 'react';
import prebind from 'meteor-react-prebind';
import { Map, fromJS } from 'immutable';

import type { TestType } from './types';
import runChecks, { warn } from './dx';
import { allTestsPassed } from './helpers';

const Formous = (options: Object): ReactClass => {
  return (Wrapped: ReactClass) => class extends Component {
    // Flow annotations
    defaultsSet: boolean;
    fieldData: Object;
    state: Object;

    constructor(props: Object) {
      super(props);
      prebind(this);

      this.defaultsSet = false;
      window.Formous = this;

      this.state = {
        fields: Map({}),
        form: {
          touched: false,
          valid: false,
        },
      };
    }

    componentWillMount() {
      const updatedFields = {};

      // Deprecation warning
      if (!options.fields) {
        warn(false, 'Put fields in their own object. See details: ' +
          'https://gist.github.com/ffxsam/1233cef6c60df350cc4d35536428409b');
        options.fields = { ...options };
      }

      // Syntax checking.. for a positive developer experience!
      runChecks(options);

      // Loop through each of the fields passed in
      for (const fieldName: string in options.fields) {
        const fieldSpec: Object = {
          ...options.fields[fieldName],
          name: fieldName,
        };

        // Events that should be attached to the input fields
        const events: Object = {
          onBlur: this.onBlur.bind(this, fieldSpec),
          onChange: this.onChange.bind(this, fieldSpec),
          onFocus: this.onFocus.bind(this),
        };

        // Set initial field validity
        const testResults: Array<TestType> = this.testField(fieldSpec, '',
          true);

        updatedFields[fieldName] = {
          events,
          valid: allTestsPassed(testResults),
          value: this.state.fields.getIn([fieldName, 'value']) || '',
        };
      }

      this.setState({
        fields: fromJS(updatedFields),
      }, this.setFormValidity);
    }

    formSubmit(formHandler: Function): Function {
      return (event: Object) => {
        event.preventDefault();
        formHandler(
          this.state.form,
          this.state.fields
            .map((field: Object) => ({ value: field.get('value') })).toJS()
        );
      }
    }

    isFormValid(options: ?{ excludeField: string }): boolean {
      const excludeField: ?string = options && options.excludeField;
      const stateFields: Object = this.state.fields.toJS();
      const examineFields: Array<string> = Object.keys(stateFields)
        .filter((fieldName: string) => fieldName !== excludeField);

      if (examineFields.length === 0) return true;

      const formValid = Object.keys(stateFields)
        .filter((fieldName: string) => fieldName !== excludeField)
        .map((fieldName: string) => stateFields[fieldName])
        .reduce((a: any, b: Object) => {
          return (typeof a === 'object' ? a.valid : a) && b.valid;
        });

      /*
       * If we only have one field, .reduce() will have returned an object, not
       * a boolean.
       */
      return typeof formValid === 'boolean' ? formValid : formValid.valid;
    }

    markFieldAsValid(fieldName: string, valid: boolean, options: {
      failProps: ?Object,
      quietly: boolean,
    }) {
      this.setState({
        fields: this.state.fields.mergeDeep({
          [fieldName]: {
            failProps: options.quietly ? undefined : options.failProps,
            valid,
          },
        }),
      }, this.setFormValidity);
    }

    onBlur(fieldSpec: Object, { target }: Object) {
      const completedTests: Array<TestType> = this.testField(fieldSpec,
        target.value);

      this.setFieldsValidity(fieldSpec, completedTests);
      // this.markFieldAsValid(
      //   field.name,
      //   failedTest ? !failedTest.critical : true,
      //   {
      //     failProps: failedTest && failedTest.failProps,
      //   });
    }

    onChange(fieldSpec: Object, { target }: Object) {
      this.setState({
        fields: this.state.fields.setIn([fieldSpec.name, 'value'],
          target.value),
      });
    }

    onFocus() {
      this.setState({
        form: {
          ...this.state.form,
          touched: true,
        },
      });
    }

    setDefaultValues(defaultData: Object) {
      // Prevent settings defaults twice
      if (!this.defaultsSet) {
        const defaults: Object = {};

        for (const fieldName: string in defaultData) {
          const field: Object = options.fields[fieldName];
          const tests: ?Array<TestType> = options.fields[fieldName] &&
            options.fields[fieldName].tests;
          let testResults: Array<TestType>;

          if (tests) {
            testResults = this.testField(field, defaultData[fieldName], true);
          } else {
            testResults = [];
          }

          defaults[fieldName] = {
            valid: allTestsPassed(testResults),
            value: defaultData[fieldName],
          };
        }

        this.setState({
          fields: this.state.fields.mergeDeep(defaults),
        }, () => {
          this.setState({
            form: {
              ...this.state.form,
              valid: this.isFormValid(),
            },
          });
        });

        this.defaultsSet = true;
      }
    }

    setFieldsValidity(fieldSpec: Object, tests: Array<TestType>) {
      const updatedFields = {};

      if (tests.length === 0) {
        // All tests passed for this field
        warn(false, 'We should never see this? If you see this, please submit' +
          'an issue at https://github.com/ffxsam/formous/issues');
      } else {
        for (const test: TestType of tests) {
          updatedFields[test.fieldName] = {
            failProps: test.passed || test.quiet
              ? undefined
              : test.failProps,
            valid: test.passed,
          };
        }

        this.setState({
          fields: this.state.fields.mergeDeep({
            ...updatedFields,
          }),
        }, this.setFormValidity);
      }
    }

    setFormValidity() {
      this.setState({
        form: {
          ...this.state.form,
          valid: this.isFormValid(),
        },
      });
    }

    // Returns all tests that were run
    testField(fieldSpec: Object, value: string,
      initial: ?boolean): Array<TestType> {
      /*
       * testField will actually start at a single field and run its tests, but
       * due to the alsoTest field, there can be chaining. So testField will
       * return an array of all failed tests.
       */
      const tests: Array<TestType> = fieldSpec.tests;
      let completedTests: Array<TestType> = [];
      let failedTestCount: number = 0;

      for (const test: Object of tests) {
        const testResult: boolean = test.test(value, this.state.fields.toJS());

        completedTests = [{
          ...test,
          passed: testResult,
          fieldName: fieldSpec.name,
        }];

        if (!testResult) break;
      }

      failedTestCount = completedTests
        .filter((test: TestType) => !test.passed).length;

      /*
       * See if there are related fields we should test
       * Check !initial, because we don't want to do side-effect tests on form
       * mount.
       */
      if (fieldSpec.alsoTest && !initial && failedTestCount === 0) {
        fieldSpec.alsoTest.forEach((fieldName: string) => {
          const fieldInfo: Object = options.fields[fieldName];
          const fieldValue: string =
            this.state.fields.getIn([fieldName, 'value']);
          let sideEffectTests: Array<TestType> =
            this.testField(fieldInfo, fieldValue);

          // Side-effect tests should never display error props
          sideEffectTests = sideEffectTests
            .map((test: Object) => ({ ...test, quiet: true }));

          completedTests = [...completedTests, ...sideEffectTests];
          // this.markFieldAsValid(
          //   fieldName,
          //   failedTest ? !failedTest.critical : true,
          //   {
          //     failProps: failedTest && failedTest.failProps,
          //     quietly: false,
          //   });
        });
      }

      return completedTests;
    }

    render() {
      return <Wrapped
        { ...this.props }
        fields={this.state.fields.toJS()}
        formSubmit={this.formSubmit}
        setDefaultValues={this.setDefaultValues}
      />
    }
  }
};

export default Formous
